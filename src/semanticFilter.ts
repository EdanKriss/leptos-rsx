// Injects a middleware into rust-analyzer's LanguageClient (which its
// extension exports for consumers) and:
//  - drops the semantic tokens that fall inside view! markup, so the RSX
//    injection grammar shows through while all embedded and surrounding Rust
//    keeps full semantic highlighting;
//  - trims the generic crate-doc section ("About Leptos") from hovers on
//    view! markup, keeping the element signature and its docs.
//
// Everything here is defensive: the exported API is semi-official, and the
// middleware lookup relies on vscode-languageclient reading `middleware` at
// request time. If any assumption fails, status stays "unavailable" and the
// worst case is today's behavior (rust-analyzer's coloring wins); the
// decorations fallback then takes over.

import * as vscode from "vscode";
import { trimCrateDocSection } from "./hoverTrim.ts";
import { inRanges, scanRsxRegions } from "./rsxRegions.ts";
import {
  applySemanticTokenEdits,
  computeLineStarts,
  filterSemanticTokenData,
  type SemanticTokensEditLike,
} from "./tokenFilter.ts";

export type FilterStatus = "attached" | "unavailable";

// Structural types for the bits of rust-analyzer / vscode-languageclient we
// touch. Typed locally so nothing from those packages is bundled and version
// drift degrades to "unavailable" instead of a crash.
interface RustAnalyzerApiLike {
  client?: LanguageClientLike;
}

interface LanguageClientLike {
  clientOptions: { middleware?: MiddlewareLike };
}

type FullSignature = (
  document: vscode.TextDocument,
  token: vscode.CancellationToken,
) => Promise<vscode.SemanticTokens | null | undefined>;

type EditsSignature = (
  document: vscode.TextDocument,
  previousResultId: string,
  token: vscode.CancellationToken,
) => Promise<vscode.SemanticTokens | SemanticTokensEditsLike | null | undefined>;

type RangeSignature = (
  document: vscode.TextDocument,
  range: vscode.Range,
  token: vscode.CancellationToken,
) => Promise<vscode.SemanticTokens | null | undefined>;

type HoverSignature = (
  document: vscode.TextDocument,
  position: vscode.Position,
  token: vscode.CancellationToken,
) => Promise<vscode.Hover | null | undefined>;

interface SemanticTokensEditsLike {
  readonly edits: readonly SemanticTokensEditLike[];
  readonly resultId?: string;
}

interface MiddlewareLike {
  provideDocumentSemanticTokens?: (
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
    next: FullSignature,
  ) => ReturnType<FullSignature>;
  provideDocumentSemanticTokensEdits?: (
    document: vscode.TextDocument,
    previousResultId: string,
    token: vscode.CancellationToken,
    next: EditsSignature,
  ) => ReturnType<EditsSignature>;
  provideDocumentRangeSemanticTokens?: (
    document: vscode.TextDocument,
    range: vscode.Range,
    token: vscode.CancellationToken,
    next: RangeSignature,
  ) => ReturnType<RangeSignature>;
  provideHover?: (
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    next: HoverSignature,
  ) => ReturnType<HoverSignature>;
}

interface RegionCacheEntry {
  version: number;
  markup: Array<[number, number]>;
  lineStarts: number[];
}

const RA_EXTENSION_ID = "rust-lang.rust-analyzer";

export class SemanticTokenFilter implements vscode.Disposable {
  private readonly statusEmitter = new vscode.EventEmitter<FilterStatus>();
  readonly onDidChangeStatus = this.statusEmitter.event;

  private _status: FilterStatus = "unavailable";
  private patchedClient: LanguageClientLike | undefined;
  private readonly regionCache = new Map<string, RegionCacheEntry>();
  /** Last *unfiltered* token data per document, for applying server deltas. */
  private readonly tokenCache = new Map<string, { resultId?: string; data: number[] }>();
  private readonly disposables: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    this.disposables.push(
      vscode.extensions.onDidChange(() => void this.tryAttach()),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        this.regionCache.delete(doc.uri.toString());
        this.tokenCache.delete(doc.uri.toString());
      }),
    );
    // rust-analyzer constructs (and on restart, re-constructs) its client
    // lazily; re-check cheaply until attached, and afterwards in case of
    // restarts. unref() so tests and shutdown aren't held open.
    this.timer = setInterval(() => void this.tryAttach(), 30_000);
    this.timer.unref?.();
    void this.tryAttach();
  }

  get status(): FilterStatus {
    return this._status;
  }

  dispose(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    for (const d of this.disposables) d.dispose();
    this.statusEmitter.dispose();
  }

  private setStatus(status: FilterStatus): void {
    if (this._status !== status) {
      this._status = status;
      this.statusEmitter.fire(status);
    }
  }

  private enabled(): boolean {
    return vscode.workspace
      .getConfiguration("leptosRsxHtml")
      .get<boolean>("filterSemanticTokens", true);
  }

  async tryAttach(): Promise<void> {
    try {
      const ext = vscode.extensions.getExtension<RustAnalyzerApiLike>(RA_EXTENSION_ID);
      if (!ext) {
        this.setStatus("unavailable");
        return;
      }
      const api = ext.isActive ? ext.exports : await ext.activate();
      const client = api?.client;
      if (!client || typeof client !== "object") {
        this.setStatus("unavailable");
        return;
      }
      if (client === this.patchedClient) {
        this.setStatus("attached");
        return;
      }
      const options = client.clientOptions;
      if (!options || typeof options !== "object") {
        this.setStatus("unavailable");
        return;
      }
      options.middleware ??= {};
      this.wrap(options.middleware);
      this.patchedClient = client;
      this.setStatus("attached");
    } catch {
      this.setStatus("unavailable");
    }
  }

  private wrap(mw: MiddlewareLike): void {
    const prevFull = mw.provideDocumentSemanticTokens;
    const prevEdits = mw.provideDocumentSemanticTokensEdits;
    const prevRange = mw.provideDocumentRangeSemanticTokens;
    const prevHover = mw.provideHover;

    mw.provideDocumentSemanticTokens = async (document, token, next) => {
      const res = prevFull ? await prevFull(document, token, next) : await next(document, token);
      if (!res || !this.applies(document)) return res;
      this.tokenCache.set(document.uri.toString(), {
        resultId: res.resultId,
        data: Array.from(res.data),
      });
      return this.filtered(document, res.data, res.resultId);
    };

    mw.provideDocumentSemanticTokensEdits = async (document, previousResultId, token, next) => {
      const res = prevEdits
        ? await prevEdits(document, previousResultId, token, next)
        : await next(document, previousResultId, token);
      if (!res || !this.applies(document)) return res;

      if (!("edits" in res)) {
        // Server answered the delta request with full tokens.
        this.tokenCache.set(document.uri.toString(), {
          resultId: res.resultId,
          data: Array.from(res.data),
        });
        return this.filtered(document, res.data, res.resultId);
      }

      const key = document.uri.toString();
      const cached = this.tokenCache.get(key);
      if (!cached || cached.resultId !== previousResultId) {
        // Can't reconstruct full data (shouldn't happen: a full request always
        // precedes deltas). Pass through; the next full request self-heals.
        return res;
      }
      const merged = applySemanticTokenEdits(cached.data, res.edits);
      this.tokenCache.set(key, { resultId: res.resultId, data: merged });
      return this.filtered(document, merged, res.resultId);
    };

    mw.provideDocumentRangeSemanticTokens = async (document, range, token, next) => {
      const res = prevRange
        ? await prevRange(document, range, token, next)
        : await next(document, range, token);
      if (!res || !this.applies(document)) return res;
      return this.filtered(document, res.data, res.resultId);
    };

    mw.provideHover = async (document, position, token, next) => {
      const res = prevHover
        ? await prevHover(document, position, token, next)
        : await next(document, position, token);
      if (!res || document.languageId !== "rust" || !this.hoverTrimEnabled()) return res;
      try {
        const regions = this.regionsFor(document);
        if (!inRanges(regions.markup, document.offsetAt(position))) return res;
        return this.trimmedHover(res);
      } catch {
        return res;
      }
    };
  }

  private hoverTrimEnabled(): boolean {
    return vscode.workspace
      .getConfiguration("leptosRsxHtml")
      .get<boolean>("filterHovers", true);
  }

  /** Returns the hover with crate-doc sections cut, or null if nothing is left. */
  private trimmedHover(hover: vscode.Hover): vscode.Hover | null {
    let changed = false;
    const contents: vscode.Hover["contents"] = [];
    for (const item of hover.contents) {
      if (typeof item === "string") {
        const trimmed = trimCrateDocSection(item);
        changed ||= trimmed !== item;
        if (trimmed) contents.push(trimmed);
        continue;
      }
      // { language, value } MarkedString code blocks can't contain sections.
      if ("language" in item || typeof item.value !== "string") {
        contents.push(item);
        continue;
      }
      const trimmed = trimCrateDocSection(item.value);
      if (trimmed === item.value) {
        contents.push(item);
        continue;
      }
      changed = true;
      if (!trimmed) continue;
      const md = new vscode.MarkdownString(trimmed);
      md.isTrusted = item.isTrusted;
      md.supportHtml = item.supportHtml;
      md.supportThemeIcons = item.supportThemeIcons;
      contents.push(md);
    }
    if (!changed) return hover;
    if (contents.length === 0) return null;
    return new vscode.Hover(contents, hover.range);
  }

  private applies(document: vscode.TextDocument): boolean {
    return this.enabled() && document.languageId === "rust";
  }

  private filtered(
    document: vscode.TextDocument,
    data: ArrayLike<number>,
    resultId: string | undefined,
  ): vscode.SemanticTokens {
    const regions = this.regionsFor(document);
    const kept = filterSemanticTokenData(data, regions.lineStarts, regions.markup);
    return new vscode.SemanticTokens(new Uint32Array(kept), resultId);
  }

  private regionsFor(document: vscode.TextDocument): RegionCacheEntry {
    const key = document.uri.toString();
    const cached = this.regionCache.get(key);
    if (cached && cached.version === document.version) return cached;
    const text = document.getText();
    const entry: RegionCacheEntry = {
      version: document.version,
      markup: scanRsxRegions(text).markup,
      lineStarts: computeLineStarts(text),
    };
    this.regionCache.set(key, entry);
    return entry;
  }
}

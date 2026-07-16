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
import { rsxHoverMarkdown, type RsxHover } from "./hover.ts";
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
    /** Raw LSP escape hatch, used to recover full tokens on delta cache misses. */
    sendRequest?: (
        method: string,
        param: unknown,
        token?: vscode.CancellationToken,
    ) => Promise<unknown>;
    code2ProtocolConverter?: { asUri?: (uri: vscode.Uri) => string };
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

// Retry cadence right after an attach trigger (activation, extension change,
// window focus). rust-analyzer creates its client lazily, so the first tries
// usually miss; the burst shrinks the unattached window from the steady poll's
// 30s to about a second.
const ATTACH_BURST_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

// Labels that head each block of the merged hover. The rust-analyzer label sits
// in its own hover section, so VS Code brackets it with a rule above *and*
// below — a far more deliberate break than the single divider array contents
// would otherwise get between our card and the tachys card.
// A Markdown thematic break renders as an <hr> — the same divider rust-analyzer
// puts between its signature and docs. It's kept on its own line ahead of the
// title (not trailing the HTML paragraph, where the hover renderer swallows it).
const HTML_LABEL = "**HTML** · MDN / W3C";
const RA_LABEL = "---\n\n**rust-analyzer**";

/**
  * Merge our RSX HTML card above rust-analyzer's (already trimmed) hover, each
  * under a heading. `base` is null when rust-analyzer had no hover (or trimming
  * emptied it), in which case we show our card alone.
  */
function mergeHover(
    base: vscode.Hover | null,
    rsx: RsxHover,
    raRange: vscode.Range | undefined,
): vscode.Hover {
    const range = raRange ?? rsx.range;
    if (!base || base.contents.length === 0) return new vscode.Hover(rsx.md, range);
    const html = new vscode.MarkdownString(`${HTML_LABEL}\n\n${rsx.md.value}`);
    return new vscode.Hover(
        [html, new vscode.MarkdownString(RA_LABEL), ...base.contents],
        range,
    );
}

export class SemanticTokenFilter implements vscode.Disposable {
    private readonly statusEmitter = new vscode.EventEmitter<FilterStatus>();
    readonly onDidChangeStatus = this.statusEmitter.event;
    private readonly effectiveEmitter = new vscode.EventEmitter<void>();
    /** Fires when filtering becomes effective (or stops being) for some document. */
    readonly onDidChangeEffective = this.effectiveEmitter.event;

    private _status: FilterStatus = "unavailable";
    private patchedClient: LanguageClientLike | undefined;
    private readonly wrappedMiddleware = new WeakSet<MiddlewareLike>();
    private readonly regionCache = new Map<string, RegionCacheEntry>();
    /** Last *unfiltered* token data per document, for applying server deltas. */
    private readonly tokenCache = new Map<string, { resultId?: string; data: number[] }>();
    private readonly disposables: vscode.Disposable[] = [];
    private timer: ReturnType<typeof setInterval> | undefined;
    private burstTimer: ReturnType<typeof setTimeout> | undefined;

    constructor() {
        this.disposables.push(
            vscode.extensions.onDidChange(() => this.startAttachBurst()),
            // After an OS sleep, rust-analyzer may have restarted its client
            // while timers were suspended; refocusing the window is the
            // earliest reliable wake signal.
            vscode.window.onDidChangeWindowState((state) => {
                if (state.focused) this.startAttachBurst();
            }),
            vscode.workspace.onDidCloseTextDocument((doc) => {
                this.regionCache.delete(doc.uri.toString());
                this.tokenCache.delete(doc.uri.toString());
            }),
        );
        // rust-analyzer constructs (and on restart, re-constructs) its client
        // lazily; the burst catches it quickly after a trigger, and the slow
        // poll is the safety net for client swaps no event announces. unref()
        // so tests and shutdown aren't held open.
        this.timer = setInterval(() => void this.tryAttach(), 30_000);
        this.timer.unref?.();
        this.startAttachBurst();
    }

    get status(): FilterStatus {
        return this._status;
    }

    dispose(): void {
        if (this.timer !== undefined) clearInterval(this.timer);
        if (this.burstTimer !== undefined) clearTimeout(this.burstTimer);
        for (const d of this.disposables) d.dispose();
        this.statusEmitter.dispose();
        this.effectiveEmitter.dispose();
    }

    /** Whether a filtered token set has actually been delivered for this document. */
    isEffective(document: vscode.TextDocument): boolean {
        return this.tokenCache.has(document.uri.toString());
    }

    private startAttachBurst(): void {
        if (this.burstTimer !== undefined) clearTimeout(this.burstTimer);
        let attempt = 0;
        const run = (): void => {
            this.burstTimer = undefined;
            void this.tryAttach();
            const delay = ATTACH_BURST_DELAYS_MS[attempt++];
            if (delay === undefined) return;
            this.burstTimer = setTimeout(run, delay);
            this.burstTimer.unref?.();
        };
        run();
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
            // A recreated client could reuse its predecessor's options object;
            // wrapping the same middleware twice would make the cache treat
            // already-filtered data as the unfiltered base for delta merges.
            if (!this.wrappedMiddleware.has(options.middleware)) {
                this.wrap(options.middleware);
                this.wrappedMiddleware.add(options.middleware);
            }
            if (this.patchedClient !== undefined && this.tokenCache.size > 0) {
                // Client swap: the new server shares no resultIds with the old
                // one, and any tokens VS Code fetched before this attach went
                // out unfiltered — drop the cache so documents count as
                // not-yet-effective until filtered tokens flow again.
                this.tokenCache.clear();
                this.effectiveEmitter.fire();
            }
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
            this.cacheTokens(document.uri.toString(), res.resultId, Array.from(res.data));
            return this.filtered(document, res.data, res.resultId);
        };

        mw.provideDocumentSemanticTokensEdits = async (document, previousResultId, token, next) => {
            const res = prevEdits
                ? await prevEdits(document, previousResultId, token, next)
                : await next(document, previousResultId, token);
            if (!res || !this.applies(document)) return res;

            if (!("edits" in res)) {
                // Server answered the delta request with full tokens.
                this.cacheTokens(document.uri.toString(), res.resultId, Array.from(res.data));
                return this.filtered(document, res.data, res.resultId);
            }

            const key = document.uri.toString();
            const cached = this.tokenCache.get(key);
            if (!cached || cached.resultId !== previousResultId) {
                // The base full response predates this middleware (it attached
                // after an extension reload or rust-analyzer restart, when VS
                // Code already held a valid resultId — VS Code then keeps
                // sending deltas indefinitely, so no full request would ever
                // self-heal this). Fetch the full set from the server directly.
                const full = await this.requestFullTokens(document, token);
                if (!full) return res; // pass through; the next delta retries
                this.cacheTokens(key, full.resultId, full.data);
                return this.filtered(document, full.data, full.resultId);
            }
            const merged = applySemanticTokenEdits(cached.data, res.edits);
            this.cacheTokens(key, res.resultId, merged);
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
            if (document.languageId !== "rust") return res;
            try {
                if (!inRanges(this.regionsFor(document).markup, document.offsetAt(position))) {
                    return res; // outside markup: rust-analyzer's hover, untouched
                }
                // In RSX markup. Optionally strip rust-analyzer's crate-doc noise, then optionally
                // prepend our HTML card so it renders above the tachys card.
                let base: vscode.Hover | null = res ?? null;
                if (base && this.hoverTrimEnabled()) base = this.trimmedHover(base);
                const mode = this.hoversMode();
                const rsx = mode === "off" ? undefined : rsxHoverMarkdown(document, position, mode);
                if (!rsx) return base ?? undefined;
                return mergeHover(base, rsx, res?.range);
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

    private hoversMode(): string {
        return vscode.workspace
            .getConfiguration("leptosRsxHtml")
            .get<string>("hovers", "all");
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

    private cacheTokens(key: string, resultId: string | undefined, data: number[]): void {
        const isNew = !this.tokenCache.has(key);
        this.tokenCache.set(key, { resultId, data });
        if (isNew) this.effectiveEmitter.fire();
    }

    /**
      * Ask the server for the document's full token set, bypassing VS Code's
      * delta bookkeeping. Returns null on any failure — client without
      * sendRequest, server busy/restarting (ContentModified), cancellation —
      * in which case the caller passes the delta through and retries later.
      */
    private async requestFullTokens(
        document: vscode.TextDocument,
        token: vscode.CancellationToken,
    ): Promise<{ resultId?: string; data: number[] } | null> {
        try {
            const client = this.patchedClient;
            if (!client?.sendRequest) return null;
            const uri =
                client.code2ProtocolConverter?.asUri?.(document.uri) ?? document.uri.toString();
            const res = await client.sendRequest(
                "textDocument/semanticTokens/full",
                { textDocument: { uri } },
                token,
            );
            if (!res || typeof res !== "object") return null;
            const { resultId, data } = res as { resultId?: unknown; data?: unknown };
            if (!Array.isArray(data)) return null;
            return {
                resultId: typeof resultId === "string" ? resultId : undefined,
                data: data as number[],
            };
        } catch {
            return null;
        }
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

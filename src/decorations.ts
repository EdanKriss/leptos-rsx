// Decorations fallback: when the semantic-token middleware can't attach
// (rust-analyzer missing its exported client, internals changed, …),
// paint the RSX markup with editor decorations instead. Decorations render
// on top of semantic tokens, so this restores sane markup coloring at the
// cost of using our own palette rather than the theme's token colors.

import * as vscode from "vscode";
import { scanRsxRegions, type Region, type RegionKind } from "./rsxRegions.ts";
import { SemanticTokenFilter } from "./semanticFilter.ts";

// Approximations of Dark+ / Light+ markup colors.
const PALETTE: Record<RegionKind, { dark: string; light: string }> = {
    tag: { dark: "#569cd6", light: "#800000" },
    component: { dark: "#4ec9b0", light: "#267f99" },
    attribute: { dark: "#9cdcfe", light: "#e50000" },
    string: { dark: "#ce9178", light: "#a31515" },
    punctuation: { dark: "#808080", light: "#800000" },
};

const KINDS = Object.keys(PALETTE) as RegionKind[];

interface DecorationCacheEntry {
    version: number;
    regions: Region[];
}

export class RsxDecorations implements vscode.Disposable {
    private readonly types: Record<RegionKind, vscode.TextEditorDecorationType>;
    private readonly cache = new Map<string, DecorationCacheEntry>();
    private readonly disposables: vscode.Disposable[] = [];
    private debounce: ReturnType<typeof setTimeout> | undefined;

    constructor(private readonly filter: SemanticTokenFilter) {
        this.types = Object.fromEntries(
            KINDS.map((kind) => [
                kind,
                vscode.window.createTextEditorDecorationType({
                    light: { color: PALETTE[kind].light },
                    dark: { color: PALETTE[kind].dark },
                }),
            ]),
        ) as Record<RegionKind, vscode.TextEditorDecorationType>;

        this.disposables.push(
            filter.onDidChangeStatus(() => this.refreshAll()),
            vscode.window.onDidChangeVisibleTextEditors(() => this.refreshAll()),
            vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document.languageId === "rust") this.scheduleRefresh();
            }),
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration("leptosRsxHtml")) this.refreshAll();
            }),
            vscode.workspace.onDidCloseTextDocument((doc) => {
                this.cache.delete(doc.uri.toString());
            }),
        );
        this.refreshAll();
    }

    dispose(): void {
        if (this.debounce !== undefined) clearTimeout(this.debounce);
        for (const d of this.disposables) d.dispose();
        for (const kind of KINDS) this.types[kind].dispose();
    }

    private active(): boolean {
        const mode = vscode.workspace
            .getConfiguration("leptosRsxHtml")
            .get<string>("decorationsFallback", "auto");
        if (mode === "off") return false;
        if (mode === "always") return true;
        // auto: only needed when rust-analyzer paints semantic tokens over the
        // grammar AND the middleware couldn't intercept them.
        return (
            this.filter.status !== "attached" &&
            vscode.extensions.getExtension("rust-lang.rust-analyzer") !== undefined
        );
    }

    private scheduleRefresh(): void {
        if (this.debounce !== undefined) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.refreshAll(), 200);
        this.debounce.unref?.();
    }

    private refreshAll(): void {
        const on = this.active();
        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document.languageId !== "rust") continue;
            if (on) this.paint(editor);
            else this.clear(editor);
        }
    }

    private clear(editor: vscode.TextEditor): void {
        for (const kind of KINDS) editor.setDecorations(this.types[kind], []);
    }

    private paint(editor: vscode.TextEditor): void {
        const document = editor.document;
        const key = document.uri.toString();
        let entry = this.cache.get(key);
        if (!entry || entry.version !== document.version) {
            entry = { version: document.version, regions: scanRsxRegions(document.getText()).decorations };
            this.cache.set(key, entry);
        }
        const byKind = new Map<RegionKind, vscode.Range[]>(KINDS.map((k) => [k, []]));
        for (const region of entry.regions) {
            byKind
                .get(region.kind)!
                .push(new vscode.Range(document.positionAt(region.start), document.positionAt(region.end)));
        }
        for (const kind of KINDS) {
            editor.setDecorations(this.types[kind], byKind.get(kind)!);
        }
    }
}

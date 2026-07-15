import * as vscode from "vscode";
import { getDefaultHTMLDataProvider } from "vscode-html-languageservice";
import { rsxContextAt } from "./rsxContext.ts";
import { htmlDoc } from "./htmlDoc.ts";
import { LEPTOS_STEMS, NODE_REF_DOC } from "./leptosData.ts";

const data = getDefaultHTMLDataProvider();

export interface RsxHover {
    md: vscode.MarkdownString;
    range: vscode.Range;
}

/**
  * The RSX HTML documentation for the token at `position` — a tag, attribute, or
  * Leptos namespace — or undefined if the position isn't a hoverable markup
  * token for the given mode (`"attributes"` skips tags, `"all"` includes them).
  * Independent of how it's presented: the standalone provider wraps it in a
  * Hover, and the rust-analyzer middleware prepends it above the tachys card.
  */
export function rsxHoverMarkdown(
    document: vscode.TextDocument,
    position: vscode.Position,
    mode: string,
): RsxHover | undefined {
    if (mode === "off") return undefined;
    const wordRange = document.getWordRangeAtPosition(position, /[\w:.-]+/);
    if (!wordRange) return undefined;
    const word = document.getText(wordRange);
    // Classifying at the word's end makes the whole word the "partial".
    const ctx = rsxContextAt(document.getText(), document.offsetAt(wordRange.end));

    if (ctx.kind === "tag-name" && !ctx.closing) {
        if (mode !== "all") return undefined;
        const md = htmlDoc(data.provideTags().find((t) => t.name === word));
        return md ? { md, range: wordRange } : undefined;
    }

    if (ctx.kind !== "attribute-name") return undefined;

    if (word === "node_ref") {
        return { md: new vscode.MarkdownString(NODE_REF_DOC), range: wordRange };
    }

    const colon = word.indexOf(":");
    if (colon !== -1) {
        const stemLabel = word.slice(0, colon + 1);
        const stem = LEPTOS_STEMS.find((s) => s.label === stemLabel);
        if (!stem) return undefined;
        let md = new vscode.MarkdownString(stem.doc);
        if (stemLabel === "on:") {
            const event = data
                .provideAttributes(ctx.component ? "div" : ctx.tag)
                .find((a) => a.name === `on${word.slice(colon + 1)}`);
            md = htmlDoc(event) ?? md;
        }
        return { md, range: wordRange };
    }

    if (ctx.component) return undefined;
    const md = htmlDoc(data.provideAttributes(ctx.tag).find((a) => a.name === word));
    return md ? { md, range: wordRange } : undefined;
}

/**
  * Standalone RSX hover, used only as a fallback. When the semantic-token filter
  * is attached to rust-analyzer, the middleware merges the same content into
  * rust-analyzer's own hover (ordered above the tachys card); a second standalone
  * card would just duplicate it. When the filter can't attach (no rust-analyzer),
  * there's no tachys card to merge into, so we surface the RSX card on its own here.
  */
export class RsxHoverProvider implements vscode.HoverProvider {
    constructor(private readonly filter: { readonly status: string }) {}

    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): vscode.Hover | undefined {
        if (this.filter.status === "attached") return undefined;
        const mode = vscode.workspace
            .getConfiguration("leptosRsxHtml")
            .get<string>("hovers", "all");
        const hover = rsxHoverMarkdown(document, position, mode);
        return hover ? new vscode.Hover(hover.md, hover.range) : undefined;
    }
}

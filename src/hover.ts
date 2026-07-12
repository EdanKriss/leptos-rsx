import * as vscode from "vscode";
import { getDefaultHTMLDataProvider } from "vscode-html-languageservice";
import { rsxContextAt } from "./rsxContext.ts";
import { htmlDoc } from "./htmlDoc.ts";
import { LEPTOS_STEMS, NODE_REF_DOC } from "./leptosData.ts";

export class RsxHoverProvider implements vscode.HoverProvider {
  private readonly data = getDefaultHTMLDataProvider();

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Hover | undefined {
    const mode = vscode.workspace
      .getConfiguration("leptosRsxHtml")
      .get<string>("hovers", "off");
    if (mode === "off") return undefined;

    const wordRange = document.getWordRangeAtPosition(position, /[\w:.-]+/);
    if (!wordRange) return undefined;
    const word = document.getText(wordRange);
    // Classifying at the word's end makes the whole word the "partial".
    const ctx = rsxContextAt(document.getText(), document.offsetAt(wordRange.end));

    // Tag hovers default off: rust-analyzer resolves tags to tachys element
    // functions whose docs already embed MDN content, so ours would stack
    // a second, redundant card on top.
    if (ctx.kind === "tag-name" && !ctx.closing) {
      if (mode !== "all") return undefined;
      const tag = this.data.provideTags().find((t) => t.name === word);
      const md = htmlDoc(tag);
      if (md) return new vscode.Hover(md, wordRange);
      return undefined;
    }

    if (ctx.kind !== "attribute-name") return undefined;

    if (word === "node_ref") {
      return new vscode.Hover(new vscode.MarkdownString(NODE_REF_DOC), wordRange);
    }

    const colon = word.indexOf(":");
    if (colon !== -1) {
      const stemLabel = word.slice(0, colon + 1);
      const stem = LEPTOS_STEMS.find((s) => s.label === stemLabel);
      if (!stem) return undefined;
      let md = new vscode.MarkdownString(stem.doc);
      if (stemLabel === "on:") {
        const event = this.data
          .provideAttributes(ctx.component ? "div" : ctx.tag)
          .find((a) => a.name === `on${word.slice(colon + 1)}`);
        md = htmlDoc(event) ?? md;
      }
      return new vscode.Hover(md, wordRange);
    }

    if (ctx.component) return undefined;
    const attr = this.data.provideAttributes(ctx.tag).find((a) => a.name === word);
    const md = htmlDoc(attr);
    if (md) return new vscode.Hover(md, wordRange);
    return undefined;
  }
}

import * as vscode from "vscode";
import type { ITagData, IAttributeData, IValueData } from "vscode-html-languageservice";
import { generateDocumentation } from "vscode-html-languageservice/lib/esm/languageFacts/dataProvider.js";

/**
  * Full documentation for an HTML data item — description plus the Baseline
  * availability line and MDN reference link(s) — as a MarkdownString, matching
  * what VS Code's built-in HTML support renders in a plain `.html` file. Reuses
  * the language service's own generator so the output stays identical.
  */
export function htmlDoc(
    item: ITagData | IAttributeData | IValueData | undefined,
): vscode.MarkdownString | undefined {
    if (!item) return undefined;
    const doc = generateDocumentation(item, {}, true);
    if (!doc?.value) return undefined;
    return new vscode.MarkdownString(doc.value);
}

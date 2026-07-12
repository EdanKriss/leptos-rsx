// Type shim for a non-public helper in vscode-html-languageservice. It builds
// the full HTML documentation block (description + Baseline availability line +
// MDN reference links) that VS Code's built-in HTML hover/completion shows;
// the package exports it from a module file but not from its public entry.
// Bundled and version-locked, so the deep path is stable at runtime; a rename
// upstream would fail the build, not degrade silently.
declare module "vscode-html-languageservice/lib/esm/languageFacts/dataProvider.js" {
  import type {
    ITagData,
    IAttributeData,
    IValueData,
    MarkupContent,
  } from "vscode-html-languageservice";
  export function generateDocumentation(
    item: ITagData | IAttributeData | IValueData,
    settings?: { documentation?: boolean; references?: boolean },
    doesSupportMarkdown?: boolean,
  ): MarkupContent | undefined;
}

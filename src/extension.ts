import * as vscode from "vscode";
import { RsxCompletionProvider } from "./completions.ts";
import { RsxHoverProvider } from "./hover.ts";
import { SemanticTokenFilter } from "./semanticFilter.ts";
import { RsxDecorations } from "./decorations.ts";

const RUST: vscode.DocumentSelector = { language: "rust" };
const REENABLE_PROMPT_KEY = "leptosRsxHtml.reenablePromptShown";

export function activate(context: vscode.ExtensionContext): void {
  const filter = new SemanticTokenFilter();
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      RUST,
      new RsxCompletionProvider(),
      "<", '"', ":", "=", "/",
    ),
    vscode.languages.registerHoverProvider(RUST, new RsxHoverProvider()),
    filter,
    new RsxDecorations(filter),
  );

  void maybeOfferReenableSemanticHighlighting(context);
}

export function deactivate(): void {}

// v0.1.x offered to disable Rust semantic highlighting wholesale; v0.2+
// filters tokens surgically instead, which only helps if semantic
// highlighting is on. Nudge once if we find the old workspace setting.
async function maybeOfferReenableSemanticHighlighting(
  context: vscode.ExtensionContext,
): Promise<void> {
  try {
    if (context.workspaceState.get(REENABLE_PROMPT_KEY)) return;
    const config = vscode.workspace.getConfiguration("editor", { languageId: "rust" });
    const inspected = config.inspect<boolean>("semanticHighlighting.enabled");
    if (inspected?.workspaceLanguageValue !== false) return;

    await context.workspaceState.update(REENABLE_PROMPT_KEY, true);
    const reenable = "Re-enable it";
    const pick = await vscode.window.showInformationMessage(
      "Leptos RSX now filters rust-analyzer's semantic tokens inside view! macros " +
        "instead of needing semantic highlighting turned off. This workspace still has " +
        "it disabled for Rust — re-enable it to get semantic refinements (mut underlines " +
        "etc.) back alongside RSX colors?",
      reenable,
      "Keep it off",
    );
    if (pick === reenable) {
      await config.update(
        "semanticHighlighting.enabled",
        undefined,
        vscode.ConfigurationTarget.Workspace,
        true,
      );
    }
  } catch {
    // Migration nicety only — never let it break activation.
  }
}

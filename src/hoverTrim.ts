// Trims the generic crate-documentation section from rust-analyzer hovers
// inside view! markup.
//
// Hovering a tag or attribute makes rust-analyzer resolve the token through
// the macro expansion, where it maps both to the real definition (the tachys
// element fn — useful) and to the crate root the expanded code references
// (`extern crate leptos` + the whole "About Leptos" crate intro — noise that
// isn't specific to the hovered item). rust-analyzer renders both into one
// markdown string with the crate section after the definition; cut from the
// `extern crate` fence onward.

const EXTERN_CRATE_FENCE =
  /(?:^|\r?\n)[ \t]*```rust[ \t]*\r?\n(?:pub\s+)?extern\s+crate\s+\w+[ \t]*\r?\n[ \t]*```/;

// rust-analyzer separates hover parts with a horizontal rule on its own line;
// which character it uses (--- vs ___) has varied across versions.
const RULES = ["---", "___"];

/**
 * Cut a trailing `extern crate …` section (fence + crate docs) from hover
 * markdown. Returns the input unchanged when no such section exists; returns
 * "" when the crate section was the entire hover.
 */
export function trimCrateDocSection(markdown: string): string {
  const match = EXTERN_CRATE_FENCE.exec(markdown);
  if (!match) return markdown;
  let head = markdown.slice(0, match.index).trimEnd();
  // Drop the section separator left dangling above the cut.
  while (RULES.some((r) => head.endsWith(r))) {
    head = head.slice(0, -3).trimEnd();
  }
  return head;
}

# Changelog

## 0.2.3

- **RSX HTML docs merged into rust-analyzer's hover, on by default.** The MDN/W3C
  card now renders **above** the tachys card inside one hover (VS Code gives no
  way to reorder separate cards), each block under a heading with a pronounced
  labeled break between them. `leptosRsxHtml.hovers` now defaults to `all`.
  When rust-analyzer isn't attached, the card still shows standalone as before.

## 0.2.2

- **Fuller HTML docs in hovers and completions.** Tag/attribute/value docs now
  include the Baseline availability line and the **MDN Reference** link, matching
  what VS Code's built-in HTML support shows in a plain `.html` file (previously
  only the description was shown). Reuses the language service's own generator.

## 0.2.1

- **Trimmed rust-analyzer hovers in markup.** Hovering a tag or attribute in
  `view!` used to append the generic `extern crate leptos` / "About Leptos"
  crate intro below the useful element docs (the token maps to the crate root
  through the macro expansion). The middleware now cuts that section, keeping
  the element signature and its docs. (`leptosRsxHtml.filterHovers`)
- New extension icon.

## 0.2.0

- **Surgical semantic-token filtering.** Instead of asking to disable Rust
  semantic highlighting (0.1.x), the extension now hooks rust-analyzer's
  exported language client and drops only the semantic tokens overlapping
  RSX markup. Markup gets the grammar's colors; embedded and surrounding
  Rust keeps full semantic highlighting. (`leptosRsxHtml.filterSemanticTokens`)
- **Decorations fallback.** If the middleware can't attach (rust-analyzer
  missing/changed), RSX markup is painted via editor decorations instead.
  (`leptosRsxHtml.decorationsFallback`: auto / always / off)
- Removed the semantic-highlighting prompt and toggle command; workspaces
  that disabled it via 0.1.x get a one-time offer to re-enable.

## 0.1.1

- Coexist with rust-analyzer: one-time prompt in Leptos workspaces to disable
  Rust semantic highlighting (which paints over RSX colors once r-a loads),
  plus a toggle command.
- RSX hovers off by default (`leptosRsxHtml.hovers`) — rust-analyzer stacks
  its own cards inside `view!`; opt into `attributes` or `all` for
  MDN-sourced docs.

## 0.1.0

Initial release.

- Injection grammar for `view!` macros with recursive brace balancing:
  element/component/fragment tags, Leptos attribute namespaces, embedded Rust
  in attribute values and `{…}` text nodes, nested `view!` support.
- Completions driven by the W3C/MDN HTML data set: tags, per-element
  attributes (incl. `aria-*`), attribute value sets, `on:` DOM events,
  Leptos namespace stems, `bind:` targets, `node_ref`.
- Hover documentation for tags, attributes, and Leptos namespaces.

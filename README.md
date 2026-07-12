# Leptos RSX (HTML)

**Proper HTML syntax highlighting and IntelliSense inside [Leptos](https://leptos.dev) `view!` macros.**

Existing RSX extensions fall apart on real-world Leptos code — the first closure in an
attribute value derails the highlighting, and completions are a short generic list.
This extension is built around two ideas:

1. A TextMate **injection grammar with recursive brace balancing**, so
   `on:click=move |_| mode.set(m)` and nested `view!` macros highlight correctly,
   with the embedded Rust getting genuine Rust highlighting.
2. Completions and hovers driven by the **same W3C/MDN HTML data VS Code's built-in
   HTML support uses** — not a hand-typed list.

## Features

### Highlighting that survives real code

- Element tags, component tags (colored like types, including paths like
  `my_crate::widgets::Fancy`), and fragments `<>…</>`
- Leptos attribute namespaces: `on:`, `class:`, `style:`, `prop:`, `attr:`,
  `bind:`, `use:`, `node_ref`
- Attribute values and `{…}` text nodes re-embed **real Rust highlighting**,
  recursively — closures, method calls, `format!` interpolation, nested `view!`

### IntelliSense that knows HTML

- **Tag completion** after `<`, and close-the-enclosing-tag after `</`
- **Per-element attribute completion**: `<span` offers span-valid + global +
  full `aria-*` attributes, with MDN documentation
- **Attribute value completion**: `type="` inside a `<button>` offers
  `button | submit | reset`; works for every value set in the HTML spec data
- **DOM events in Leptos form**: `on:click`, `on:input`, … with docs
- **Leptos namespaces** (`class:`, `prop:`, `bind:value`, …) with usage hints
- **Hover docs** for tags and attributes, sourced from MDN
- Stays out of rust-analyzer's way: inside `{…}` blocks and bare Rust attribute
  values, no HTML suggestions are offered

## Playing nicely with rust-analyzer

Once rust-analyzer finishes indexing, its *semantic highlighting* normally
paints over TextMate colors inside `view!` macros (the macro maps spans back
to your source, so nearly every RSX token gets a semantic token, and semantic
tokens always beat grammars). Other RSX extensions either live with the mush
or tell you to disable semantic highlighting for Rust entirely.

This extension does neither. It attaches a middleware to rust-analyzer's
language client (via the API the rust-analyzer extension exports) and
**filters out only the semantic tokens that overlap RSX markup** — tags,
attribute names, quoted values. The result:

- markup keeps the RSX grammar's colors, permanently;
- embedded Rust *inside* `view!` (closures, `{…}` blocks) and every other
  line of Rust keep **full** semantic highlighting — mutable-variable
  underlines and all. Nothing is disabled anywhere.

Controlled by `leptosRsxHtml.filterSemanticTokens` (default on). The hook
leans on semi-official rust-analyzer surface; if a future update breaks it,
the extension degrades gracefully: `leptosRsxHtml.decorationsFallback`
(default `auto`) then paints the markup with editor decorations — sane
colors from the extension's palette rather than your theme's, and never a
functional loss.

The same hook also cleans up **hovers** inside markup: rust-analyzer's hover
on a tag like `div` resolves through the macro expansion and appends the
generic `extern crate leptos` / "About Leptos" crate intro below the useful
element docs. The middleware trims that section off, keeping the tachys
signature and MDN element docs (`leptosRsxHtml.filterHovers`, default on).

RSX hovers are **off by default**: rust-analyzer stacks its own hover cards
inside `view!` (its tachys element docs even embed MDN content), so extra
cards read as noise. If you want MDN documentation on attribute names and
Leptos namespaces (`aria-*`, `on:`, `bind:`, …), set `leptosRsxHtml.hovers`
to `"attributes"` — or `"all"` to add tag hovers too.

## Known limitations

- Unbraced attribute values containing a bare `>` (e.g.
  `when=move || count.get() > 0`) confuse the highlighter — wrap the expression
  in braces: `when=move || { count.get() > 0 }`. (Every RSX grammar shares this
  ambiguity; braces are also what leptosfmt produces.)
- `view!` bodies using `()` or `[]` delimiters instead of `{}` are not recognized.

## Roadmap

- Typed `on:` event payload docs, `style:` CSS property completion
- Snippets: `view!`, `#[component]`, `<Show>`, `<For>`, `<Suspense>`
- Completion for Leptos control-flow components and their props
- Workspace scanning for `#[component]` functions → complete your own
  components and their props
- leptosfmt formatter integration

Issues and ideas welcome.

## License

MIT

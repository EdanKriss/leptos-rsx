import { test } from "node:test";
import assert from "node:assert/strict";
import { trimCrateDocSection } from "../../src/hoverTrim.ts";

const DEFINITION = [
    "```rust",
    "tachys::html::element::elements",
    "```",
    "",
    "```rust",
    "pub fn div() -> HtmlElement<Div, (), ()>",
    "```",
    "",
    "---",
    "",
    "The `<div>` HTML element is the generic container for flow content.",
].join("\n");

const CRATE_SECTION = [
    "```rust",
    "extern crate leptos",
    "```",
    "",
    "# About Leptos",
    "",
    "Leptos is a full-stack framework for building web applications in Rust.",
].join("\n");

test("cuts the extern crate section and the dangling separator", () => {
    const trimmed = trimCrateDocSection(`${DEFINITION}\n\n---\n\n${CRATE_SECTION}`);
    assert.ok(trimmed.includes("generic container for flow content"));
    assert.ok(!trimmed.includes("About Leptos"));
    assert.ok(!trimmed.includes("extern crate"));
    assert.ok(!trimmed.trimEnd().endsWith("---"), "no dangling separator");
});

test("returns input unchanged when there is no crate section", () => {
    assert.equal(trimCrateDocSection(DEFINITION), DEFINITION);
});

test("crate-only hover trims to empty", () => {
    assert.equal(trimCrateDocSection(CRATE_SECTION), "");
});

test("pub extern crate re-exports are also cut", () => {
    const md = `${DEFINITION}\n\n---\n\n\`\`\`rust\npub extern crate leptos\n\`\`\`\n\ndocs`;
    assert.ok(!trimCrateDocSection(md).includes("extern"));
});

test("mentions of extern crate in prose or code blocks are not cut", () => {
    const prose = "Use `extern crate leptos` in old editions.";
    assert.equal(trimCrateDocSection(prose), prose);
    const nonRustFence = "```toml\nextern crate leptos\n```";
    assert.equal(trimCrateDocSection(nonRustFence), nonRustFence);
});

test("strips the dangling rule whichever character rust-analyzer used", () => {
    for (const rule of ["---", "___"]) {
        const md = `${DEFINITION}\n\n${rule}\n\n${CRATE_SECTION}`;
        const trimmed = trimCrateDocSection(md);
        assert.ok(trimmed.includes("generic container for flow content"), `kept docs (${rule})`);
        assert.ok(!/^[-_]{3,}$/.test(trimmed.split("\n").pop()?.trim() ?? ""),
            `no dangling rule left (${rule})`);
    }
});

test("thematic breaks inside kept docs survive", () => {
    const withRule = [
        "```rust",
        "pub fn hr() -> HtmlElement<Hr, (), ()>",
        "```",
        "",
        "---",
        "",
        "The `<hr>` element. Example:",
        "",
        "---", // a legitimate rule *inside* the docs, not trailing
        "",
        "More prose after the rule.",
    ].join("\n");
    const md = `${withRule}\n\n---\n\n${CRATE_SECTION}`;
    const trimmed = trimCrateDocSection(md);
    assert.ok(trimmed.includes("More prose after the rule."), "docs after an inner rule survive");
    assert.ok(!trimmed.includes("About Leptos"));
});

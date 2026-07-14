import { test } from "node:test";
import assert from "node:assert/strict";
import { rsxContextAt, type RsxPosition } from "../../src/rsxContext.ts";

// `‸` marks the cursor in the source snippet.
function at(source: string): RsxPosition {
    const offset = source.indexOf("‸");
    assert.notEqual(offset, -1, "test snippet must contain a ‸ cursor marker");
    return rsxContextAt(source.replace("‸", ""), offset);
}

const VIEW = (body: string) => `fn c() -> impl IntoView { view! { ${body} } }`;

test("plain rust is not rsx", () => {
    assert.deepEqual(at("fn main() { let x = ‸1; }"), { kind: "none" });
});

test("view! in a string or comment is not rsx", () => {
    assert.deepEqual(at('fn f() { let s = "view! { <p ‸"; }'), { kind: "none" });
    assert.deepEqual(at("fn f() { // view! { <p ‸\n }"), { kind: "none" });
});

test("content position inside view!", () => {
    const pos = at(VIEW("<div> ‸ </div>"));
    assert.deepEqual(pos, { kind: "content", parentTag: "div" });
});

test("freshly typed <", () => {
    const pos = at(VIEW("<div> <‸ </div>"));
    assert.deepEqual(pos, { kind: "tag-name", partial: "", closing: false, parentTag: "div" });
});

test("partial tag name", () => {
    const pos = at(VIEW("<but‸"));
    assert.deepEqual(pos, { kind: "tag-name", partial: "but", closing: false, parentTag: null });
});

test("closing tag name", () => {
    const pos = at(VIEW("<button> </but‸"));
    assert.deepEqual(pos, { kind: "tag-name", partial: "but", closing: true, parentTag: "button" });
});

test("attribute-name position after tag", () => {
    const pos = at(VIEW('<button ‸>"x"</button>'));
    assert.deepEqual(pos, { kind: "attribute-name", tag: "button", component: false, partial: "" });
});

test("partial attribute name", () => {
    const pos = at(VIEW("<button ty‸"));
    assert.deepEqual(pos, { kind: "attribute-name", tag: "button", component: false, partial: "ty" });
});

test("partial namespaced attribute", () => {
    const pos = at(VIEW("<button on:cli‸"));
    assert.deepEqual(pos, { kind: "attribute-name", tag: "button", component: false, partial: "on:cli" });
});

test("attribute-name after a quoted value", () => {
    const pos = at(VIEW('<input type="checkbox" ‸/>'));
    assert.deepEqual(pos, { kind: "attribute-name", tag: "input", component: false, partial: "" });
});

test("empty quoted attribute value", () => {
    const pos = at(VIEW('<button type="‸"'));
    assert.deepEqual(pos, {
        kind: "attribute-value", tag: "button", component: false,
        attribute: "type", quoted: true, partial: "",
    });
});

test("partial quoted attribute value", () => {
    const pos = at(VIEW('<button type="sub‸'));
    assert.deepEqual(pos, {
        kind: "attribute-value", tag: "button", component: false,
        attribute: "type", quoted: true, partial: "sub",
    });
});

test("cursor right after =", () => {
    const pos = at(VIEW("<button type=‸"));
    assert.deepEqual(pos, {
        kind: "attribute-value", tag: "button", component: false,
        attribute: "type", quoted: false, partial: "",
    });
});

test("bare rust value is rust territory", () => {
    assert.deepEqual(at(VIEW("<button on:click=move |_| mo‸")), { kind: "none" });
});

test("brace interpolation is rust territory", () => {
    assert.deepEqual(at(VIEW("<p> {count.g‸} </p>")), { kind: "none" });
});

test("quoted text node is not a completion site", () => {
    assert.deepEqual(at(VIEW('<p>"hel‸lo"</p>')), { kind: "none" });
});

test("component tags are flagged", () => {
    const pos = at(VIEW("<Show wh‸"));
    assert.deepEqual(pos, { kind: "attribute-name", tag: "Show", component: true, partial: "wh" });
});

test("path components are flagged", () => {
    const pos = at(VIEW("<my_crate::widgets::Fancy ‸"));
    assert.equal(pos.kind, "attribute-name");
    assert.equal((pos as any).component, true);
});

test("bare value ends at newline, next line is attribute position", () => {
    const pos = at(VIEW("<button\n  on:click=move |_| mode.set(m)\n  ty‸"));
    assert.deepEqual(pos, { kind: "attribute-name", tag: "button", component: false, partial: "ty" });
});

test("bare value with parens containing spaces stays open", () => {
    assert.deepEqual(at(VIEW("<button aria-checked=move || (a == b).to_str‸")), { kind: "none" });
});

test("nested view! inside a closure works", () => {
    const src = `fn c() -> impl IntoView {
    view! {
      <div>
        {items.iter().map(|m| view! { <button ty‸ }).collect_view()}
      </div>
    }
  }`;
    const pos = at(src);
    assert.deepEqual(pos, { kind: "attribute-name", tag: "button", component: false, partial: "ty" });
});

test("after a closed view! macro we are back in rust", () => {
    assert.deepEqual(at("fn c() { let v = view! { <p></p> }; le‸ }"), { kind: "none" });
});

test("fragment children report no parent", () => {
    const pos = at(VIEW("<> ‸ </>"));
    assert.deepEqual(pos, { kind: "content", parentTag: null });
});

test("spread braces inside a tag are rust", () => {
    assert.deepEqual(at(VIEW("<input {..att‸} />")), { kind: "none" });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { scanRsxRegions, inRanges } from "../../src/rsxRegions.ts";

/** Concatenated text covered by the markup ranges. */
function markupText(source: string): string {
    const { markup } = scanRsxRegions(source);
    return markup.map(([s, e]) => source.slice(s, e)).join("⋯");
}

function decorationTexts(source: string, kind: string): string[] {
    return scanRsxRegions(source)
        .decorations.filter((r) => r.kind === kind)
        .map((r) => source.slice(r.start, r.end));
}

const SRC = `fn c() -> impl IntoView {
    let x = compute();
    view! {
        <div class="card" aria-label="Card">
            {header.title}
            <button class:is-active=move || mode.get() == m on:click=move |_| { mode.set(m) }>
                "text node" {m.icon()}
            </button>
            <Show when=move || count.get() != 0 fallback=|| view! { <span>"nested"</span> }>
                <my_crate::Fancy />
            </Show>
        </div>
    }
}
`;

test("markup covers tags, attributes, quoted values", () => {
    const m = markupText(SRC);
    assert.ok(m.includes('<div class="card" aria-label="Card">'), "div open tag is markup");
    assert.ok(m.includes("</button>"), "close tag is markup");
    assert.ok(m.includes("class:is-active="), "leptos attr + = is markup");
    assert.ok(m.includes('"text node"'), "quoted text node is markup");
    assert.ok(m.includes("<my_crate::Fancy />"), "component tag is markup");
});

test("markup excludes rust: bare values, brace blocks, surrounding code", () => {
    const m = markupText(SRC);
    assert.ok(!m.includes("mode.get() == m"), "bare value rust excluded");
    assert.ok(!m.includes("mode.set(m)"), "braced closure body excluded");
    assert.ok(!m.includes("header.title"), "text interpolation excluded");
    assert.ok(!m.includes("m.icon()"), "text interpolation excluded");
    assert.ok(!m.includes("compute()"), "code outside view! excluded");
    assert.ok(!m.includes("count.get()"), "component bare value excluded");
});

test("nested view! inside a bare value contributes markup", () => {
    const m = markupText(SRC);
    assert.ok(m.includes("<span>"), "nested view tag is markup");
    assert.ok(m.includes('"nested"'), "nested text node is markup");
});

test("markup ranges are sorted and non-overlapping", () => {
    const { markup } = scanRsxRegions(SRC);
    for (let i = 1; i < markup.length; i++) {
        assert.ok(markup[i][0] >= markup[i - 1][1], `range ${i} overlaps/regresses`);
    }
});

test("no view! macro means no markup", () => {
    assert.deepEqual(scanRsxRegions("fn main() { let a = vec![1]; }").markup, []);
});

test("decorations classify kinds", () => {
    assert.ok(decorationTexts(SRC, "tag").includes("div"));
    assert.ok(decorationTexts(SRC, "tag").includes("button"));
    assert.ok(decorationTexts(SRC, "component").includes("Show"));
    assert.ok(decorationTexts(SRC, "component").includes("my_crate::Fancy"));
    assert.ok(decorationTexts(SRC, "attribute").includes("class:is-active"));
    assert.ok(decorationTexts(SRC, "attribute").includes("aria-label"));
    assert.ok(decorationTexts(SRC, "string").includes('"card"'));
    assert.ok(decorationTexts(SRC, "string").includes('"text node"'));
    assert.ok(decorationTexts(SRC, "punctuation").includes("</"));
});

test("decorations never label rust code", () => {
    const all = scanRsxRegions(SRC).decorations.map((r) => SRC.slice(r.start, r.end)).join(" ");
    assert.ok(!all.includes("mode.set"), "closure body not decorated");
    assert.ok(!all.includes("count.get"), "bare value not decorated");
});

test("inRanges binary search", () => {
    const ranges: Array<[number, number]> = [[2, 5], [10, 12], [20, 30]];
    assert.equal(inRanges(ranges, 1), false);
    assert.equal(inRanges(ranges, 2), true);
    assert.equal(inRanges(ranges, 4), true);
    assert.equal(inRanges(ranges, 5), false);
    assert.equal(inRanges(ranges, 11), true);
    assert.equal(inRanges(ranges, 25), true);
    assert.equal(inRanges(ranges, 30), false);
    assert.equal(inRanges([], 0), false);
});

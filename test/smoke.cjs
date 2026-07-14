// Drives the *built* extension bundle (dist/extension.js) outside VS Code by
// stubbing the `vscode` module, and replays the scenarios the old extension
// failed at. Run via `npm run test:smoke` (after `npm run build`).
"use strict";
const assert = require("node:assert/strict");
const Module = require("node:module");

// ---- vscode stub ----------------------------------------------------------
class Position {
    constructor(line, character) { this.line = line; this.character = character; }
}
class Range {
    constructor(start, end) { this.start = start; this.end = end; }
}
const registered = { completion: null, hover: null, triggers: null };
const noopDisposable = () => ({ dispose() {} });
// Fake rust-analyzer extension whose exported client our middleware patches.
const fakeRaClient = { clientOptions: {} };
const fakeRaExtension = { isActive: true, exports: { client: fakeRaClient } };
const vscodeStub = {
    Position,
    Range,
    CompletionItem: class { constructor(label, kind) { this.label = label; this.kind = kind; } },
    CompletionItemKind: new Proxy({}, { get: (_t, k) => String(k) }),
    MarkdownString: class { constructor(value) { this.value = value; } },
    SnippetString: class { constructor(value) { this.value = value; } },
    Hover: class { constructor(contents, range) { this.contents = contents; this.range = range; } },
    SemanticTokens: class { constructor(data, resultId) { this.data = data; this.resultId = resultId; } },
    EventEmitter: class {
        constructor() { this.listeners = []; }
        get event() { return (fn) => { this.listeners.push(fn); return { dispose() {} }; }; }
        fire(value) { for (const fn of this.listeners) fn(value); }
        dispose() {}
    },
    extensions: {
        getExtension: (id) => (id === "rust-lang.rust-analyzer" ? fakeRaExtension : undefined),
        onDidChange: noopDisposable,
    },
    languages: {
        registerCompletionItemProvider(_sel, provider, ...triggers) {
            registered.completion = provider;
            registered.triggers = triggers;
            return { dispose() {} };
        },
        registerHoverProvider(_sel, provider) {
            registered.hover = provider;
            return { dispose() {} };
        },
    },
    commands: { registerCommand: noopDisposable },
    window: {
        showInformationMessage: async () => undefined,
        setStatusBarMessage: noopDisposable,
        createTextEditorDecorationType: noopDisposable,
        onDidChangeVisibleTextEditors: noopDisposable,
        visibleTextEditors: [],
    },
    ConfigurationTarget: { Workspace: 2 },
    workspace: {
        // `hovers`: exercise the non-default "all" mode so tag hovers are testable.
        getConfiguration: () => ({
            get: (key, dflt) => (key === "hovers" ? "all" : dflt),
            update: async () => {},
            inspect: () => undefined,
        }),
        findFiles: async () => [],
        fs: { readFile: async () => new Uint8Array() },
        onDidCloseTextDocument: noopDisposable,
        onDidChangeTextDocument: noopDisposable,
        onDidChangeConfiguration: noopDisposable,
    },
};
const origLoad = Module._load;
Module._load = function (id, ...rest) {
    return id === "vscode" ? vscodeStub : origLoad.apply(this, [id, ...rest]);
};

// ---- fake TextDocument ----------------------------------------------------
let docCounter = 0;
function doc(text) {
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
    const uriString = `file:///smoke/${++docCounter}.rs`;
    return {
        uri: { toString: () => uriString },
        version: 1,
        languageId: "rust",
        getText(range) {
            if (!range) return text;
            return text.slice(this.offsetAt(range.start), this.offsetAt(range.end));
        },
        offsetAt: (pos) => lineStarts[pos.line] + pos.character,
        positionAt(offset) {
            let line = lineStarts.findIndex((s, i) => s <= offset && (lineStarts[i + 1] ?? Infinity) > offset);
            if (line === -1) line = lineStarts.length - 1;
            return new Position(line, offset - lineStarts[line]);
        },
        getWordRangeAtPosition(pos, re) {
            const offset = this.offsetAt(pos);
            let start = offset, end = offset;
            const one = (i) => re.test(text[i] ?? "");
            while (start > 0 && one(start - 1)) start--;
            while (end < text.length && one(end)) end++;
            if (start === end) return undefined;
            return new Range(this.positionAt(start), this.positionAt(end));
        },
    };
}

/** Build a doc from a snippet with a ‸ cursor marker; returns [doc, position]. */
function cursor(snippet) {
    const offset = snippet.indexOf("‸");
    assert.notEqual(offset, -1);
    const d = doc(snippet.replace("‸", ""));
    return [d, d.positionAt(offset)];
}

// ---- scenarios ------------------------------------------------------------
const ext = require("../dist/extension.js");
ext.activate({
    subscriptions: [],
    workspaceState: { get: () => true, update: async () => {} },
});
assert.ok(registered.completion, "completion provider registered");
assert.ok(registered.hover, "hover provider registered");

const complete = (snippet) => {
    const [d, p] = cursor(snippet);
    return registered.completion.provideCompletionItems(d, p) ?? [];
};
const labels = (items) => items.map((i) => i.label);

// Screenshot 3: ctrl+space inside a tag → full per-element attribute list.
{
    const items = complete('fn c() { view! { <span cl‸></span> } }');
    const ls = labels(items);
    assert.ok(ls.includes("class"), "span offers class");
    assert.ok(ls.includes("aria-checked"), "span offers aria-*");
    assert.ok(ls.includes("on:click"), "span offers on:click event");
    assert.ok(ls.includes("class:"), "span offers leptos class: stem");
    assert.ok(ls.includes("node_ref"), "span offers node_ref");
    assert.ok(items.length > 150, `rich attribute list (got ${items.length})`);
}

// Screenshot 4: value completion inside button type="".
{
    const items = complete('fn c() { view! { <button type="‸"></button> } }');
    assert.deepEqual(labels(items).sort(), ["button", "reset", "submit"]);
}

// Unquoted value position gets quoted insertions.
{
    const items = complete("fn c() { view! { <input type=‸ /> } }");
    assert.ok(items.length > 10, "input type has many values");
    assert.ok(items.every((i) => i.insertText.startsWith('"')), "unquoted values get quotes");
}

// Tag-name completion.
{
    const items = complete("fn c() { view! { <‸ } }");
    const ls = labels(items);
    assert.ok(ls.includes("button") && ls.includes("dialog"), "element list present");
    assert.ok(items.length > 100, `full tag list (got ${items.length})`);
}

// Closing-tag helper.
{
    const items = complete("fn c() { view! { <nav> </‸ } }");
    assert.equal(items[0].label, "nav");
    assert.equal(items[0].insertText, "nav>");
}

// Components: leptos stems only, no HTML attribute noise.
{
    const items = complete("fn c() { view! { <Show ‸ } }");
    const ls = labels(items);
    assert.ok(ls.includes("on:click"), "components accept on:");
    assert.ok(ls.includes("attr:"), "components accept attr:");
    assert.ok(!ls.includes("class"), "no plain HTML attrs on components");
}

// Rust positions stay quiet (rust-analyzer's turf).
{
    assert.equal(complete("fn c() { view! { <p> {count.g‸} </p> } }").length, 0);
    assert.equal(complete("fn c() { let x = ‸1; }").length, 0);
}

// Standalone hover is suppressed while the middleware is attached (it merges
// our card into rust-analyzer's hover instead of stacking a second card). The
// merge itself is exercised through the middleware below.
{
    const [d, p] = cursor("fn c() { view! { <but‸ton type=x></button> } }");
    assert.equal(registered.hover.provideHover(d, p), undefined,
        "standalone hover suppressed while middleware attached");
}

// ---- semantic-token middleware, end to end ------------------------------
(async () => {
    // The filter attaches asynchronously during activate; give it a tick.
    await new Promise((r) => setTimeout(r, 20));
    const mw = fakeRaClient.clientOptions.middleware;
    assert.ok(mw && typeof mw.provideDocumentSemanticTokens === "function",
        "middleware injected into rust-analyzer's client");

    const text =
        'fn c() { view! { <button class="x" on:click=move |_| mode.set(m)> {m.icon()} </button> } }';
    const d = doc(text);

    // One token per interesting word, all on line 0.
    const words = ["fn", "button", "class", "mode", "icon"];
    const positions = words
        .map((w) => ({ w, at: text.indexOf(w === "icon" ? "icon" : w) }))
        .sort((a, b) => a.at - b.at);
    const data = [];
    let prev = 0;
    for (const { w, at } of positions) {
        data.push(0, at - prev, w.length, 1, 0);
        prev = at;
    }

    const decodeChars = (arr) => {
        const out = [];
        let char = 0;
        for (let i = 0; i + 4 < arr.length; i += 5) { char = arr[i] === 0 ? char + arr[i + 1] : arr[i + 1]; out.push(char); }
        return out;
    };

    // Full request: markup tokens (button, class) dropped; rust tokens kept.
    const full = await mw.provideDocumentSemanticTokens(d, {}, async () => ({
        data: new Uint32Array(data), resultId: "1",
    }));
    const keptChars = decodeChars(Array.from(full.data));
    const expectKept = positions.filter((p) => ["fn", "mode", "icon"].includes(p.w)).map((p) => p.at);
    assert.deepEqual(keptChars, expectKept, "kept exactly fn/mode/icon tokens");
    assert.equal(full.resultId, "1", "resultId preserved");

    // Delta request: empty edit set against the cached unfiltered data.
    const delta = await mw.provideDocumentSemanticTokensEdits(d, "1", {}, async () => ({
        edits: [], resultId: "2",
    }));
    assert.deepEqual(decodeChars(Array.from(delta.data)), expectKept, "delta path re-filters full data");
    assert.equal(delta.resultId, "2");

    // Disabled filter passes tokens through untouched (config gate).
    // (getConfiguration stub returns defaults; simulate by non-rust doc instead.)
    const plain = doc("fn main() {}");
    plain.languageId = "python";
    const untouched = await mw.provideDocumentSemanticTokens(plain, {}, async () => ({
        data: new Uint32Array([0, 0, 2, 1, 0]), resultId: "9",
    }));
    assert.deepEqual(Array.from(untouched.data), [0, 0, 2, 1, 0], "non-rust documents untouched");

    // Hover middleware: generic crate docs trimmed on markup, untouched on Rust.
    assert.ok(typeof mw.provideHover === "function", "hover middleware injected");
    const hoverText =
        'fn c() { view! { <button class="x" on:click=move |_| mode.set(m)> "hi" </button> } }';
    const hd = doc(hoverText);
    const raHover = () => new vscodeStub.Hover([new vscodeStub.MarkdownString([
        "```rust\ntachys::html::element::elements\n```",
        "```rust\npub fn button() -> HtmlElement<Button, (), ()>\n```",
        "---",
        "The `<button>` HTML element is an interactive element.",
        "---",
        "```rust\nextern crate leptos\n```",
        "# About Leptos\n\nLeptos is a full-stack framework for building web applications in Rust.",
    ].join("\n\n"))]);
    const posOf = (word) => hd.positionAt(hoverText.indexOf(word));

    const onTag = await mw.provideHover(hd, posOf("button"), {}, async () => raHover());
    const ourCard = onTag.contents[0].value;
    const wholeHover = onTag.contents.map((c) => c.value).join("\n\n");
    // Our HTML card comes first, under its label, with the full plain-.html doc.
    assert.ok(/\*\*HTML\*\*/.test(ourCard), "our card labeled and first");
    assert.ok(/button element represents a button/.test(ourCard), "our W3C description");
    assert.ok(/MDN Reference\]\(https:\/\//.test(ourCard), "our card has MDN link");
    assert.ok(/Baseline/.test(ourCard), "our card has Baseline status");
    // The tachys card follows under its own labeled band, crate intro trimmed.
    assert.ok(onTag.contents.some((c) => /^---\n\n\*\*rust-analyzer\*\*$/.test(c.value)),
        "rust-analyzer section is introduced by a divider + label between the two blocks");
    assert.ok(/pub fn button/.test(wholeHover) && /interactive element/.test(wholeHover),
        "tachys signature and docs kept below");
    assert.ok(!/About Leptos/.test(wholeHover), "crate intro trimmed from merged hover");

    const onRust = await mw.provideHover(hd, posOf("mode"), {}, async () => raHover());
    assert.ok(/About Leptos/.test(onRust.contents[0].value),
        "hovers on embedded Rust are untouched (no trim, no merge)");

    console.log("smoke: all scenarios pass ✓");
})().catch((err) => { console.error(err); process.exit(1); });

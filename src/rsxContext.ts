// Position classification for Leptos RSX: given a Rust source string and a
// cursor offset, decide whether the cursor sits inside a `view!` macro and, if
// so, whether markup-shaped completions (tag / attribute / value) make sense
// there or the position belongs to embedded Rust (rust-analyzer's domain).
//
// This module is deliberately free of any `vscode` imports so it can be unit
// tested with plain `node --test`.

export type RsxPosition =
    | { kind: "none" }
    | { kind: "tag-name"; partial: string; closing: boolean; parentTag: string | null }
    | { kind: "attribute-name"; tag: string; component: boolean; partial: string }
    | {
            kind: "attribute-value";
            tag: string;
            component: boolean;
            attribute: string | null;
            quoted: boolean;
            partial: string;
        }
    | { kind: "content"; parentTag: string | null };

export const VOID_ELEMENTS = new Set([
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
]);

interface TagCtx {
    name: string;
    closing: boolean;
    nameComplete: boolean;
    lastAttr: string | null;
    /** null = between attributes; otherwise the state of the value being read */
    value: null | { state: "pending" } | { state: "bare"; depth: number };
}

interface ViewFrame {
    kind: "view";
    tag: TagCtx | null;
    tagStack: string[];
}

interface RustFrame {
    kind: "rust";
}

type Frame = ViewFrame | RustFrame;

type Interrupted =
    | null
    | "comment"
    | "rust-string"
    | "text-string"
    | { kind: "value-string"; contentStart: number };

const VIEW_MACRO_LOOKBACK = /(?:\bleptos\s*::\s*)?\bview\s*!\s*$/;
const NEXT_ATTR_LOOKAHEAD = /^\s+[\w-]+(?::[\w.:-]+)?\s*=/;
const ATTR_WORD = /[\w:.-]/;

function isComponentName(name: string): boolean {
    return /^[A-Z]/.test(name) || name.includes("::");
}

/** Classify the cursor position `offset` within Rust source `text`. */
export function rsxContextAt(text: string, offset: number): RsxPosition {
    const stack: Frame[] = [{ kind: "rust" }];
    let interrupted: Interrupted = null;
    let i = 0;
    const end = Math.min(offset, text.length);

    const top = () => stack[stack.length - 1];

    // Bounded skip helpers: each returns the index just past the construct, or
    // `end` (setting `interrupted`) when the cursor lies inside it.
    function skipLineComment(from: number): number {
        let j = from;
        while (j < end && text[j] !== "\n") j++;
        if (j >= end && text[j] !== "\n") interrupted = "comment";
        return j;
    }

    function skipBlockComment(from: number): number {
        // Rust block comments nest.
        let depth = 1;
        let j = from + 2;
        while (j < end && depth > 0) {
            if (text.startsWith("/*", j)) { depth++; j += 2; }
            else if (text.startsWith("*/", j)) { depth--; j += 2; }
            else j++;
        }
        if (depth > 0) interrupted = "comment";
        return j;
    }

    function skipDoubleQuoted(from: number, mark: Interrupted): number {
        let j = from + 1;
        while (j < end) {
            if (text[j] === "\\") { j += 2; continue; }
            if (text[j] === '"') return j + 1;
            j++;
        }
        interrupted = mark;
        return j;
    }

    function skipRawString(from: number): number {
        // `from` points at `r`; consume r#*" ... "#*
        let j = from + 1;
        let hashes = 0;
        while (j < end && text[j] === "#") { hashes++; j++; }
        if (text[j] !== '"') return from + 1; // not a raw string after all
        j++;
        const closer = '"' + "#".repeat(hashes);
        const at = text.indexOf(closer, j);
        if (at === -1 || at + closer.length > end) {
            interrupted = "rust-string";
            return end;
        }
        return at + closer.length;
    }

    /** Push a view or rust frame for the `{` at index `j`. */
    function pushBrace(j: number): void {
        if (VIEW_MACRO_LOOKBACK.test(text.slice(Math.max(0, j - 64), j))) {
            stack.push({ kind: "view", tag: null, tagStack: [] });
        } else {
            stack.push({ kind: "rust" });
        }
    }

    function popBrace(): void {
        if (stack.length > 1) stack.pop();
    }

    /** Shared Rust-ish lexing for rust frames and bare attribute values.
      *  Returns the next index, or -1 when the char wasn't consumed here. */
    function rustCommon(j: number): number {
        const c = text[j];
        if (c === "/" && text[j + 1] === "/") return skipLineComment(j);
        if (c === "/" && text[j + 1] === "*") return skipBlockComment(j);
        if (c === '"') return skipDoubleQuoted(j, "rust-string");
        if (c === "r" && (text[j + 1] === '"' || text[j + 1] === "#")) return skipRawString(j);
        if (c === "'") {
            const m = /^'(?:\\.|[^\\'])'/.exec(text.slice(j, j + 5));
            return j + (m ? m[0].length : 1); // char literal vs. lifetime
        }
        return -1;
    }

    while (i < end) {
        const frame = top();
        const c = text[i];

        if (frame.kind === "rust") {
            const consumed = rustCommon(i);
            if (consumed !== -1) { i = consumed; continue; }
            if (c === "{") { pushBrace(i); i++; continue; }
            if (c === "}") { popBrace(); i++; continue; }
            i++;
            continue;
        }

        // frame.kind === "view"
        const tag = frame.tag;

        if (tag === null) {
            // ----- markup content -----
            if (c === "/" && text[i + 1] === "/") { i = skipLineComment(i); continue; }
            if (c === "/" && text[i + 1] === "*") { i = skipBlockComment(i); continue; }
            if (c === '"') { i = skipDoubleQuoted(i, "text-string"); continue; }
            if (c === "{") { pushBrace(i); i++; continue; }
            if (c === "}") { popBrace(); i++; continue; }
            if (c === "<") {
                const next = text[i + 1];
                if (next === ">") { i += 2; continue; } // fragment <>
                if (next === "/") {
                    frame.tag = { name: "", closing: true, nameComplete: false, lastAttr: null, value: null };
                    i += 2;
                    continue;
                }
                if (i + 1 >= end || /[A-Za-z_]/.test(next ?? "")) {
                    // Real tag start, or the cursor sits right after a freshly typed `<`.
                    frame.tag = { name: "", closing: false, nameComplete: false, lastAttr: null, value: null };
                    i++;
                    continue;
                }
            }
            i++;
            continue;
        }

        // ----- inside a tag -----
        if (!tag.nameComplete) {
            if (ATTR_WORD.test(c) || c === ":") {
                tag.name += c;
                i++;
                continue;
            }
            tag.nameComplete = true;
            continue; // reprocess `c` below on next iteration
        }

        if (tag.value?.state === "pending") {
            if (c === " " || c === "\t") { i++; continue; }
            if (c === '"') {
                const contentStart = i + 1;
                const after = skipDoubleQuoted(i, { kind: "value-string", contentStart });
                tag.value = null;
                i = after;
                continue;
            }
            if (c === "{") { tag.value = null; pushBrace(i); i++; continue; }
            if (c === ">" || c === "\n") { tag.value = null; continue; }
            tag.value = { state: "bare", depth: 0 };
            continue;
        }

        if (tag.value?.state === "bare") {
            const consumed = rustCommon(i);
            if (consumed !== -1) { i = consumed; continue; }
            if (c === "{") { pushBrace(i); i++; continue; }
            if (c === "(" || c === "[") { tag.value.depth++; i++; continue; }
            if (c === ")" || c === "]") { tag.value.depth = Math.max(0, tag.value.depth - 1); i++; continue; }
            if (tag.value.depth === 0) {
                if (c === ">" && text[i - 1] !== "=" && text[i - 1] !== "-") { tag.value = null; continue; }
                if (c === "/" && text[i + 1] === ">") { tag.value = null; continue; }
                if (c === "\n") { tag.value = null; i++; continue; }
                if ((c === " " || c === "\t") && NEXT_ATTR_LOOKAHEAD.test(text.slice(i, i + 128))) {
                    tag.value = null;
                    continue;
                }
            }
            i++;
            continue;
        }

        // between attributes
        if (c === "/" && text[i + 1] === "/") { i = skipLineComment(i); continue; }
        if (c === "/" && text[i + 1] === "*") { i = skipBlockComment(i); continue; }
        if (c === "/" && text[i + 1] === ">") { frame.tag = null; i += 2; continue; }
        if (c === ">") {
            if (tag.closing) {
                if (tag.name !== "") frame.tagStack.pop(); // empty name = fragment `</>`
            } else if (tag.name !== "" && !VOID_ELEMENTS.has(tag.name) && !isComponentName(tag.name)) {
                frame.tagStack.push(tag.name);
            }
            frame.tag = null;
            i++;
            continue;
        }
        if (c === "=") { tag.value = { state: "pending" }; i++; continue; }
        if (c === "{") { pushBrace(i); i++; continue; }
        if (c === '"') { i = skipDoubleQuoted(i, { kind: "value-string", contentStart: i + 1 }); continue; }
        if (ATTR_WORD.test(c)) {
            let j = i;
            let word = "";
            while (j < end && ATTR_WORD.test(text[j])) { word += text[j]; j++; }
            tag.lastAttr = word;
            i = j;
            continue;
        }
        i++;
    }

    // ----- classify the state we stopped in -----
    const frame = top();
    // `as` re-widens: TS's flow analysis can't see the assignments made inside
    // the skip helpers above.
    const intr = interrupted as Interrupted;

    if (frame.kind === "rust") return { kind: "none" };

    if (intr === "comment" || intr === "rust-string" || intr === "text-string") {
        return { kind: "none" };
    }

    const tag = frame.tag;

    if (intr && typeof intr === "object" && intr.kind === "value-string") {
        if (tag === null) return { kind: "none" }; // quoted text node, not a value
        return {
            kind: "attribute-value",
            tag: tag.name,
            component: isComponentName(tag.name),
            attribute: tag.lastAttr,
            quoted: true,
            partial: text.slice(intr.contentStart, end),
        };
    }

    if (tag === null) {
        return { kind: "content", parentTag: frame.tagStack.at(-1) ?? null };
    }

    if (!tag.nameComplete) {
        return {
            kind: "tag-name",
            partial: tag.name,
            closing: tag.closing,
            parentTag: frame.tagStack.at(-1) ?? null,
        };
    }

    if (tag.value?.state === "pending") {
        return {
            kind: "attribute-value",
            tag: tag.name,
            component: isComponentName(tag.name),
            attribute: tag.lastAttr,
            quoted: false,
            partial: "",
        };
    }

    if (tag.value?.state === "bare") return { kind: "none" };

    const partial = /[\w:.-]*$/.exec(text.slice(Math.max(0, end - 128), end))?.[0] ?? "";
    return {
        kind: "attribute-name",
        tag: tag.name,
        component: isComponentName(tag.name),
        partial,
    };
}

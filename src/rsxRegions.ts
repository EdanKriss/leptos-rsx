// Full-document RSX scanner. Produces:
//
//  - `markup`: coarse offset ranges covering the *markup structure* of every
//    view! macro — tags, attribute names, quoted values, text nodes — but NOT
//    embedded Rust ({…} blocks, bare attribute values). rust-analyzer semantic
//    tokens are dropped inside these ranges so the injection grammar shows
//    through, while Rust code everywhere (including inside the macro) keeps
//    full semantic highlighting.
//
//  - `decorations`: the same structure classified by kind, for the decoration
//    fallback when the semantic-token middleware can't attach.
//
// This intentionally mirrors the state machine in rsxContext.ts. The two scan
// for different outputs (cursor classification vs. region emission) and each
// has its own test suite; keep their tokenization rules in sync when editing.

export type RegionKind = "tag" | "component" | "attribute" | "string" | "punctuation";

export interface Region {
    kind: RegionKind;
    start: number;
    end: number;
}

export interface RsxRegions {
    /** Merged, sorted [start, end) offset ranges where semantic tokens are dropped. */
    markup: Array<[number, number]>;
    decorations: Region[];
}

interface TagCtx {
    name: string;
    closing: boolean;
    nameComplete: boolean;
    value: null | { state: "pending" } | { state: "bare"; depth: number };
}

interface ViewFrame {
    kind: "view";
    tag: TagCtx | null;
}

interface RustFrame {
    kind: "rust";
}

type Frame = ViewFrame | RustFrame;

const VIEW_MACRO_LOOKBACK = /(?:\bleptos\s*::\s*)?\bview\s*!\s*$/;
const NEXT_ATTR_LOOKAHEAD = /^\s+[\w-]+(?::[\w.:-]+)?\s*=/;
const ATTR_WORD = /[\w:.-]/;

function isComponentName(name: string): boolean {
    return /^[A-Z]/.test(name) || name.includes("::");
}

export function scanRsxRegions(text: string): RsxRegions {
    const len = text.length;
    const stack: Frame[] = [{ kind: "rust" }];
    const markup: Array<[number, number]> = [];
    const decorations: Region[] = [];
    let segStart: number | null = null;
    let i = 0;

    const top = () => stack[stack.length - 1];

    const openSeg = (at: number) => {
        if (segStart === null) segStart = at;
    };
    const closeSeg = (at: number) => {
        if (segStart !== null && at > segStart) markup.push([segStart, at]);
        segStart = null;
    };
    const emit = (kind: RegionKind, start: number, end: number) => {
        if (end > start) decorations.push({ kind, start, end });
    };

    /** Is the current frame a view frame currently in markup (not a bare value)? */
    const inViewMarkup = (): boolean => {
        const f = top();
        return f.kind === "view" && f.tag?.value?.state !== "bare";
    };

    function skipLineComment(from: number): number {
        let j = from;
        while (j < len && text[j] !== "\n") j++;
        return j;
    }

    function skipBlockComment(from: number): number {
        let depth = 1;
        let j = from + 2;
        while (j < len && depth > 0) {
            if (text.startsWith("/*", j)) { depth++; j += 2; }
            else if (text.startsWith("*/", j)) { depth--; j += 2; }
            else j++;
        }
        return j;
    }

    function skipDoubleQuoted(from: number): number {
        let j = from + 1;
        while (j < len) {
            if (text[j] === "\\") { j += 2; continue; }
            if (text[j] === '"') return j + 1;
            j++;
        }
        return j;
    }

    function skipRawString(from: number): number {
        let j = from + 1;
        let hashes = 0;
        while (j < len && text[j] === "#") { hashes++; j++; }
        if (text[j] !== '"') return from + 1;
        j++;
        const closer = '"' + "#".repeat(hashes);
        const at = text.indexOf(closer, j);
        return at === -1 ? len : at + closer.length;
    }

    function rustCommon(j: number): number {
        const c = text[j];
        if (c === "/" && text[j + 1] === "/") return skipLineComment(j);
        if (c === "/" && text[j + 1] === "*") return skipBlockComment(j);
        if (c === '"') return skipDoubleQuoted(j);
        if (c === "r" && (text[j + 1] === '"' || text[j + 1] === "#")) return skipRawString(j);
        if (c === "'") {
            const m = /^'(?:\\.|[^\\'])'/.exec(text.slice(j, j + 5));
            return j + (m ? m[0].length : 1);
        }
        return -1;
    }

    /** Handle a `{` at index j, from markup context or rust context. */
    function pushBrace(j: number, fromViewMarkup: boolean): void {
        if (VIEW_MACRO_LOOKBACK.test(text.slice(Math.max(0, j - 64), j))) {
            if (!fromViewMarkup) openSeg(j); // macro brace joins the markup
            stack.push({ kind: "view", tag: null });
        } else {
            if (fromViewMarkup) closeSeg(j + 1); // `{` stays markup, contents are rust
            stack.push({ kind: "rust" });
        }
    }

    /** Handle a `}` at index j that pops the current frame. */
    function popBrace(j: number): void {
        if (stack.length > 1) {
            const popped = stack.pop()!;
            if (popped.kind === "view") closeSeg(j);
        }
        if (inViewMarkup()) openSeg(j); // `}` rejoins the enclosing markup
    }

    while (i < len) {
        const frame = top();
        const c = text[i];

        if (frame.kind === "rust") {
            const consumed = rustCommon(i);
            if (consumed !== -1) { i = consumed; continue; }
            if (c === "{") { pushBrace(i, false); i++; continue; }
            if (c === "}") { popBrace(i); i++; continue; }
            i++;
            continue;
        }

        const tag = frame.tag;

        if (tag === null) {
            // ----- markup content -----
            if (c === "/" && text[i + 1] === "/") { i = skipLineComment(i); continue; }
            if (c === "/" && text[i + 1] === "*") { i = skipBlockComment(i); continue; }
            if (c === '"') {
                const after = skipDoubleQuoted(i);
                emit("string", i, after);
                i = after;
                continue;
            }
            if (c === "{") { pushBrace(i, true); i++; continue; }
            if (c === "}") { closeSeg(i); popBrace(i); i++; continue; }
            if (c === "<") {
                const next = text[i + 1];
                if (next === ">") { emit("punctuation", i, i + 2); i += 2; continue; }
                if (next === "/") {
                    emit("punctuation", i, i + 2);
                    frame.tag = { name: "", closing: true, nameComplete: false, value: null };
                    i += 2;
                    continue;
                }
                if (/[A-Za-z_]/.test(next ?? "")) {
                    emit("punctuation", i, i + 1);
                    frame.tag = { name: "", closing: false, nameComplete: false, value: null };
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
                const start = i;
                let name = "";
                while (i < len && (ATTR_WORD.test(text[i]) || text[i] === ":")) { name += text[i]; i++; }
                tag.name = name;
                tag.nameComplete = true;
                emit(isComponentName(name) ? "component" : "tag", start, i);
                continue;
            }
            tag.nameComplete = true;
            continue;
        }

        if (tag.value?.state === "pending") {
            if (c === " " || c === "\t") { i++; continue; }
            if (c === '"') {
                const after = skipDoubleQuoted(i);
                emit("string", i, after);
                tag.value = null;
                i = after;
                continue;
            }
            if (c === "{") { tag.value = null; pushBrace(i, true); i++; continue; }
            if (c === ">" || c === "\n") { tag.value = null; continue; }
            tag.value = { state: "bare", depth: 0 };
            closeSeg(i); // bare value is rust territory
            continue;
        }

        if (tag.value?.state === "bare") {
            const consumed = rustCommon(i);
            if (consumed !== -1) { i = consumed; continue; }
            if (c === "{") { pushBrace(i, false); i++; continue; }
            if (c === "(" || c === "[") { tag.value.depth++; i++; continue; }
            if (c === ")" || c === "]") { tag.value.depth = Math.max(0, tag.value.depth - 1); i++; continue; }
            if (tag.value.depth === 0) {
                if (c === ">" && text[i - 1] !== "=" && text[i - 1] !== "-") { tag.value = null; openSeg(i); continue; }
                if (c === "/" && text[i + 1] === ">") { tag.value = null; openSeg(i); continue; }
                if (c === "\n") { tag.value = null; openSeg(i); i++; continue; }
                if ((c === " " || c === "\t") && NEXT_ATTR_LOOKAHEAD.test(text.slice(i, i + 128))) {
                    tag.value = null;
                    openSeg(i);
                    continue;
                }
            }
            i++;
            continue;
        }

        // between attributes
        if (c === "/" && text[i + 1] === "/") { i = skipLineComment(i); continue; }
        if (c === "/" && text[i + 1] === "*") { i = skipBlockComment(i); continue; }
        if (c === "/" && text[i + 1] === ">") {
            emit("punctuation", i, i + 2);
            frame.tag = null;
            i += 2;
            continue;
        }
        if (c === ">") {
            emit("punctuation", i, i + 1);
            frame.tag = null;
            i++;
            continue;
        }
        if (c === "=") { tag.value = { state: "pending" }; i++; continue; }
        if (c === "{") { pushBrace(i, true); i++; continue; }
        if (c === '"') {
            const after = skipDoubleQuoted(i);
            emit("string", i, after);
            i = after;
            continue;
        }
        if (ATTR_WORD.test(c)) {
            const start = i;
            while (i < len && ATTR_WORD.test(text[i])) i++;
            emit("attribute", start, i);
            continue;
        }
        i++;
    }

    closeSeg(len);

    // Merge touching/overlapping ranges (already sorted by construction).
    const merged: Array<[number, number]> = [];
    for (const [s, e] of markup) {
        const last = merged[merged.length - 1];
        if (last && s <= last[1]) last[1] = Math.max(last[1], e);
        else merged.push([s, e]);
    }

    return { markup: merged, decorations };
}

/** Binary search: is `offset` inside any [start, end) range? */
export function inRanges(ranges: Array<[number, number]>, offset: number): boolean {
    let lo = 0;
    let hi = ranges.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const [s, e] = ranges[mid];
        if (offset < s) hi = mid - 1;
        else if (offset >= e) lo = mid + 1;
        else return true;
    }
    return false;
}

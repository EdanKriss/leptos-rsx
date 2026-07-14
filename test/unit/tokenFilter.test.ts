import { test } from "node:test";
import assert from "node:assert/strict";
import {
    applySemanticTokenEdits,
    computeLineStarts,
    filterSemanticTokenData,
} from "../../src/tokenFilter.ts";

// Build delta-encoded token data from absolute [line, char, len] triples.
function encode(tokens: Array<[number, number, number]>): number[] {
    const out: number[] = [];
    let line = 0;
    let char = 0;
    for (const [l, c, len] of tokens) {
        const dLine = l - line;
        const dChar = dLine === 0 ? c - char : c;
        out.push(dLine, dChar, len, 1, 0);
        line = l;
        char = c;
    }
    return out;
}

function decode(data: ArrayLike<number>): Array<[number, number, number]> {
    const out: Array<[number, number, number]> = [];
    let line = 0;
    let char = 0;
    for (let i = 0; i + 4 < data.length; i += 5) {
        line += data[i];
        char = data[i] === 0 ? char + data[i + 1] : data[i + 1];
        out.push([line, char, data[i + 2]]);
    }
    return out;
}

test("filter drops tokens inside markup and re-encodes deltas", () => {
    //          0123456789...
    const text = "aaa bbb\nccc ddd\neee";
    const lineStarts = computeLineStarts(text);
    // markup covers line 1 entirely (offsets 8..15)
    const markup: Array<[number, number]> = [[8, 15]];
    const tokens: Array<[number, number, number]> = [
        [0, 0, 3], // aaa   keep
        [0, 4, 3], // bbb   keep
        [1, 0, 3], // ccc   drop (offset 8)
        [1, 4, 3], // ddd   drop (offset 12)
        [2, 0, 3], // eee   keep
    ];
    const filtered = filterSemanticTokenData(encode(tokens), lineStarts, markup);
    assert.deepEqual(decode(filtered), [
        [0, 0, 3],
        [0, 4, 3],
        [2, 0, 3],
    ]);
});

test("filter with no markup returns identical data", () => {
    const data = encode([[0, 0, 2], [3, 1, 4]]);
    assert.deepEqual(filterSemanticTokenData(data, [0], []), data);
});

test("delta line re-encoding across dropped tokens", () => {
    const text = "x\ny\nz\nw";
    const lineStarts = computeLineStarts(text);
    const markup: Array<[number, number]> = [[2, 3]]; // line 1 = "y"
    const tokens: Array<[number, number, number]> = [
        [0, 0, 1],
        [1, 0, 1], // dropped
        [3, 0, 1],
    ];
    const filtered = filterSemanticTokenData(encode(tokens), lineStarts, markup);
    // remaining second token must be 3 lines after the first
    assert.deepEqual(decode(filtered), [
        [0, 0, 1],
        [3, 0, 1],
    ]);
});

test("applySemanticTokenEdits splices like the LSP spec", () => {
    const data = [0, 0, 1, 1, 0, /**/ 1, 0, 2, 2, 0, /**/ 1, 0, 3, 3, 0];
    // Replace the middle tuple, then append at the end.
    const result = applySemanticTokenEdits(data, [
        { start: 5, deleteCount: 5, data: [1, 2, 9, 9, 0] },
        { start: 15, deleteCount: 0, data: [1, 0, 4, 4, 0] },
    ]);
    assert.deepEqual(result, [
        0, 0, 1, 1, 0,
        1, 2, 9, 9, 0,
        1, 0, 3, 3, 0,
        1, 0, 4, 4, 0,
    ]);
});

test("applySemanticTokenEdits handles missing data field", () => {
    const data = [0, 0, 1, 1, 0, 1, 0, 2, 2, 0];
    const result = applySemanticTokenEdits(data, [{ start: 5, deleteCount: 5 }]);
    assert.deepEqual(result, [0, 0, 1, 1, 0]);
});

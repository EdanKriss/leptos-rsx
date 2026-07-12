// Pure helpers for LSP semantic token data. No vscode imports — unit tested
// with plain node.
//
// Semantic token data is a flat array of 5-tuples:
//   [deltaLine, deltaStartChar, length, tokenType, tokenModifiers]
// where deltaStartChar is relative to the previous token when deltaLine is 0,
// absolute otherwise.

import { inRanges } from "./rsxRegions.ts";

/** Offsets of each line start, for converting token line/char to offsets. */
export function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/**
 * Drop tokens whose start position falls inside any markup range and
 * re-encode the deltas. Returns a new array; the input is not modified.
 */
export function filterSemanticTokenData(
  data: ArrayLike<number>,
  lineStarts: number[],
  markup: Array<[number, number]>,
): number[] {
  if (markup.length === 0) {
    return Array.from(data as ArrayLike<number>);
  }
  const out: number[] = [];
  let line = 0;
  let char = 0;
  let keptLine = 0;
  let keptChar = 0;

  for (let i = 0; i + 4 < data.length; i += 5) {
    const dLine = data[i];
    const dChar = data[i + 1];
    line += dLine;
    char = dLine === 0 ? char + dChar : dChar;

    const offset = (lineStarts[line] ?? Number.MAX_SAFE_INTEGER) + char;
    if (inRanges(markup, offset)) continue;

    const outDLine = line - keptLine;
    const outDChar = outDLine === 0 ? char - keptChar : char;
    out.push(outDLine, outDChar, data[i + 2], data[i + 3], data[i + 4]);
    keptLine = line;
    keptChar = char;
  }
  return out;
}

export interface SemanticTokensEditLike {
  start: number;
  deleteCount: number;
  data?: ArrayLike<number>;
}

/** Apply LSP semantic-token delta edits to a full (unfiltered) data array. */
export function applySemanticTokenEdits(
  data: ArrayLike<number>,
  edits: readonly SemanticTokensEditLike[],
): number[] {
  const result = Array.from(data as ArrayLike<number>);
  // Apply highest-start first so earlier edits' indices stay valid.
  const ordered = [...edits].sort((a, b) => b.start - a.start);
  for (const edit of ordered) {
    result.splice(edit.start, edit.deleteCount, ...Array.from(edit.data ?? []));
  }
  return result;
}

import type { LineRange } from '@silykat/core';

// Pure conversions between VS Code's 0-based positions and the stored 1-based inclusive lines.
// Kept free of `vscode` imports so it can be unit-tested.

export interface Pos {
  line: number;
  character: number;
}

/** A range ending at column 0 of a later line does not include that line (whole-line selections). */
export function toLineRange(start: Pos, end: Pos): LineRange {
  const endLine = end.character === 0 && end.line > start.line ? end.line - 1 : end.line;
  return { startLine: start.line + 1, endLine: endLine + 1 };
}

export function toZeroBasedLines(range: LineRange): { start: number; end: number } {
  return { start: range.startLine - 1, end: range.endLine - 1 };
}

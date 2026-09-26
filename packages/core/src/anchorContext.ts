import type { Anchor, LineRange } from './types';

const CONTEXT_LINES = 3;

export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** Clamps a range to the lines that actually exist in the file. */
export function clampRange(range: LineRange, lineCount: number): LineRange {
  const max = Math.max(1, lineCount);
  const startLine = Math.min(Math.max(1, range.startLine), max);
  const endLine = Math.min(Math.max(startLine, range.endLine), max);
  return { startLine, endLine };
}

export function buildAnchorContext(
  fileText: string,
  range: LineRange,
): Pick<Anchor, 'range' | 'snippet' | 'contextBefore' | 'contextAfter'> {
  const lines = splitLines(fileText);
  const r = clampRange(range, lines.length);
  const start = r.startLine - 1;
  const end = r.endLine; // exclusive, 0-based
  return {
    range: r,
    snippet: lines.slice(start, end).join('\n'),
    contextBefore: lines.slice(Math.max(0, start - CONTEXT_LINES), start),
    contextAfter: lines.slice(end, end + CONTEXT_LINES),
  };
}

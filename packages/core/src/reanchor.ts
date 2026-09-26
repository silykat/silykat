import { splitLines } from './anchorContext';
import type { Anchor, LineRange } from './types';

export type ReanchorResult =
  /** The snippet is still at the stored lines. */
  | { kind: 'exact'; range: LineRange }
  /** The snippet was found, unchanged, at other lines. */
  | { kind: 'moved'; range: LineRange }
  /** The snippet was found with only whitespace changes (re-indented, reformatted spacing). */
  | { kind: 'fuzzy'; range: LineRange }
  /** The snippet is nowhere to be found as is. */
  | { kind: 'lost' };

/**
 * Finds where an anchor's code is in the current file content, in this order:
 * 1. the exact snippet at the stored lines;
 * 2. the exact snippet elsewhere;
 * 3. the snippet ignoring whitespace (indentation, spacing).
 * Among several occurrences, the closest to the stored position wins, then the one whose
 * surrounding lines match best. Returns `null` for file-level anchors (no range).
 */
export function reanchor(anchor: Anchor, fileText: string): ReanchorResult | null {
  if (!anchor.range) return null;
  const lines = splitLines(fileText);
  const snippet = splitLines(anchor.snippet);
  const n = snippet.length;
  const toRange = (i: number): LineRange => ({ startLine: i + 1, endLine: i + n });
  const stored = anchor.range.startLine - 1;

  const exactAt = (i: number) => i >= 0 && i + n <= lines.length && snippet.every((l, k) => lines[i + k] === l);
  if (exactAt(stored)) return { kind: 'exact', range: toRange(stored) };
  const moved = closest(anchor, lines, n, stored, exactAt);
  if (moved !== undefined) return { kind: 'moved', range: toRange(moved) };

  const normalized = snippet.map(normalize);
  // A snippet made only of blank lines would match anywhere once normalized.
  if (normalized.every((l) => l === '')) return { kind: 'lost' };
  const looseAt = (i: number) =>
    i >= 0 && i + n <= lines.length && normalized.every((l, k) => normalize(lines[i + k]!) === l);
  const fuzzy = closest(anchor, lines, n, stored, looseAt);
  return fuzzy !== undefined ? { kind: 'fuzzy', range: toRange(fuzzy) } : { kind: 'lost' };
}

/** Whitespace-insensitive form of a line: trimmed, inner runs of whitespace removed. */
function normalize(line: string): string {
  return line.replace(/\s+/g, '');
}

/** Index of the matching occurrence closest to `stored` (context lines as tie-break), if any. */
function closest(
  anchor: Anchor,
  lines: string[],
  n: number,
  stored: number,
  matchesAt: (i: number) => boolean,
): number | undefined {
  let best: { i: number; distance: number; context: number } | undefined;
  for (let i = 0; i + n <= lines.length; i++) {
    if (!matchesAt(i)) continue;
    const candidate = { i, distance: Math.abs(i - stored), context: contextScore(anchor, lines, i, n) };
    if (
      !best ||
      candidate.distance < best.distance ||
      (candidate.distance === best.distance && candidate.context > best.context)
    ) {
      best = candidate;
    }
  }
  return best?.i;
}

/** Number of surrounding lines that still match the anchor's recorded context. */
function contextScore(anchor: Anchor, lines: string[], start: number, n: number): number {
  let score = 0;
  anchor.contextBefore.forEach((l, k) => {
    if (lines[start - anchor.contextBefore.length + k] === l) score++;
  });
  anchor.contextAfter.forEach((l, k) => {
    if (lines[start + n + k] === l) score++;
  });
  return score;
}

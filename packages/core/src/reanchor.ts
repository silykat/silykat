import { splitLines } from './anchorContext';
import type { Anchor, LineRange } from './types';

export type ReanchorResult =
  /** The snippet is still at the stored lines. */
  | { kind: 'exact'; range: LineRange }
  /** The snippet was found, unchanged, at other lines. */
  | { kind: 'moved'; range: LineRange }
  /** The snippet is nowhere to be found as is. */
  | { kind: 'lost' };

/**
 * Finds where an anchor's code is in the current file content.
 * Exact match at the stored lines first, then the exact snippet elsewhere: the closest
 * occurrence to the stored position wins, then the one whose surrounding lines match best.
 * Returns `null` for file-level anchors (no range).
 */
export function reanchor(anchor: Anchor, fileText: string): ReanchorResult | null {
  if (!anchor.range) return null;
  const lines = splitLines(fileText);
  const snippet = splitLines(anchor.snippet);
  const n = snippet.length;
  const matchesAt = (i: number) => i >= 0 && i + n <= lines.length && snippet.every((l, k) => lines[i + k] === l);
  const toRange = (i: number): LineRange => ({ startLine: i + 1, endLine: i + n });

  const stored = anchor.range.startLine - 1;
  if (matchesAt(stored)) return { kind: 'exact', range: toRange(stored) };

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
  return best ? { kind: 'moved', range: toRange(best.i) } : { kind: 'lost' };
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

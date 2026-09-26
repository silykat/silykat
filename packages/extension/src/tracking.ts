// Pure line tracking: where does a thread's range go when the document is edited?
// Kept free of `vscode` imports so it can be unit-tested.

/** 0-based, inclusive line span. */
export interface LineSpan {
  start: number;
  end: number;
}

/** A text change, with positions in the document *before* the change (like VS Code's contentChanges). */
export interface TextChange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  text: string;
}

function countNewlines(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Applies one change to a span. */
export function shiftSpan(span: LineSpan, c: TextChange): LineSpan {
  const added = countNewlines(c.text);
  const delta = added - (c.endLine - c.startLine);

  // Entirely above the span, or ending at column 0 of its first line (e.g. lines inserted
  // right above): the span's own text is untouched and simply moves.
  if (c.endLine < span.start || (c.endLine === span.start && c.endCharacter === 0 && c.startLine <= span.start)) {
    return { start: span.start + delta, end: span.end + delta };
  }
  // Entirely below the span.
  if (c.startLine > span.end) return span;

  // Overlaps the span: it grows or shrinks, and is never dropped.
  const start = span.start <= c.startLine ? span.start : c.startLine;
  const end = span.end > c.endLine ? span.end + delta : c.startLine + added;
  return { start, end: Math.max(start, end) };
}

/** Applies all changes of one edit. They refer to the same original document, so apply bottom-up. */
export function applyChanges(span: LineSpan, changes: readonly TextChange[]): LineSpan {
  const sorted = [...changes].sort((a, b) => b.startLine - a.startLine || b.startCharacter - a.startCharacter);
  return sorted.reduce(shiftSpan, span);
}

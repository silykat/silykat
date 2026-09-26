import { describe, expect, it } from 'vitest';
import { toLineRange, toZeroBasedLines } from '../../src/range';

describe('toLineRange', () => {
  it('converts 0-based positions to 1-based inclusive lines', () => {
    expect(toLineRange({ line: 9, character: 0 }, { line: 11, character: 5 })).toEqual({ startLine: 10, endLine: 12 });
  });

  it('excludes the last line when the selection ends at its column 0', () => {
    expect(toLineRange({ line: 9, character: 0 }, { line: 12, character: 0 })).toEqual({ startLine: 10, endLine: 12 });
  });

  it('keeps a single empty-selection line', () => {
    expect(toLineRange({ line: 4, character: 0 }, { line: 4, character: 0 })).toEqual({ startLine: 5, endLine: 5 });
  });

  it('round-trips with toZeroBasedLines', () => {
    expect(toZeroBasedLines({ startLine: 10, endLine: 12 })).toEqual({ start: 9, end: 11 });
  });
});

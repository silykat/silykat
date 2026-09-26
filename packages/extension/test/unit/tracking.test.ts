import { describe, expect, it } from 'vitest';
import { applyChanges, shiftSpan, type TextChange } from '../../src/tracking';

const SPAN = { start: 19, end: 21 }; // lines 20-22 in 1-based terms
const insert = (line: number, character: number, text: string): TextChange => ({
  startLine: line,
  startCharacter: character,
  endLine: line,
  endCharacter: character,
  text,
});
const remove = (fromLine: number, toLine: number): TextChange => ({
  startLine: fromLine,
  startCharacter: 0,
  endLine: toLine,
  endCharacter: 0,
  text: '',
});

describe('shiftSpan', () => {
  it('moves down with lines inserted above (AC 1)', () => {
    expect(shiftSpan(SPAN, insert(0, 0, 'a\nb\nc\nd\ne\n'))).toEqual({ start: 24, end: 26 });
  });

  it('moves down with lines inserted right above its first line', () => {
    expect(shiftSpan(SPAN, insert(19, 0, 'new\n'))).toEqual({ start: 20, end: 22 });
  });

  it('moves up with lines deleted above', () => {
    expect(shiftSpan(SPAN, remove(2, 5))).toEqual({ start: 16, end: 18 });
  });

  it('does not move for edits below, or on the same lines without new lines', () => {
    expect(shiftSpan(SPAN, insert(30, 0, 'x\ny\n'))).toEqual(SPAN);
    expect(shiftSpan(SPAN, insert(20, 4, 'abc'))).toEqual(SPAN);
  });

  it('grows with lines inserted inside (AC 4)', () => {
    expect(shiftSpan(SPAN, insert(20, 3, 'X\nY\n'))).toEqual({ start: 19, end: 23 });
    expect(shiftSpan(SPAN, insert(21, 10, '\nmore'))).toEqual({ start: 19, end: 22 });
  });

  it('shrinks with lines deleted inside, down to a single line (AC 4)', () => {
    expect(shiftSpan(SPAN, remove(20, 21))).toEqual({ start: 19, end: 20 });
    expect(shiftSpan(SPAN, { startLine: 18, startCharacter: 0, endLine: 23, endCharacter: 0, text: '' })).toEqual({
      start: 18,
      end: 18,
    });
  });

  it('follows a deletion that starts above and ends inside', () => {
    expect(shiftSpan(SPAN, remove(17, 20))).toEqual({ start: 17, end: 18 });
  });
});

describe('applyChanges', () => {
  it('applies several changes of one edit, whatever their order', () => {
    const changes = [insert(0, 0, 'a\n'), insert(40, 0, 'z\n'), insert(10, 0, 'b\nc\n')];
    expect(applyChanges(SPAN, changes)).toEqual({ start: 22, end: 24 });
    expect(applyChanges(SPAN, [...changes].reverse())).toEqual({ start: 22, end: 24 });
  });
});

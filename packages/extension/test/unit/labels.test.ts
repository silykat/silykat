import { describe, expect, it } from 'vitest';
import type { ThreadState } from '@local-review/core';
import { outdatedQuote, threadLabel } from '../../src/labels';

const state = (over: Partial<ThreadState>): ThreadState =>
  ({ status: 'open', lastAuthor: 'user', lastAgentName: null, ...over }) as ThreadState;

describe('threadLabel', () => {
  it('names the agent in status labels', () => {
    expect(threadLabel(state({}))).toBe('Waiting for Claude');
    expect(threadLabel(state({ status: 'needs-info', lastAgentName: 'Codex' }))).toBe(
      '❓ Codex is waiting for your reply',
    );
  });

  it('flags outdated threads, keeping the status', () => {
    expect(threadLabel(state({}), true)).toBe('⚠️ Outdated · Waiting for Claude');
    expect(threadLabel(state({ status: 'resolved' }), true)).toBe('⚠️ Outdated');
    expect(threadLabel(state({ status: 'resolved' }), false)).toBeUndefined();
  });
});

describe('outdatedQuote', () => {
  it('quotes the original code in a fenced block', () => {
    expect(outdatedQuote('return null;')).toBe(
      '*This code is no longer in the file:*\n\n```\nreturn null;\n```\n\n---\n\n',
    );
  });

  it('uses a fence the snippet cannot close', () => {
    const q = outdatedQuote('const s = `a` + "```";');
    expect(q).toContain('\n````\nconst s');
    expect(q).toContain('";\n````\n');
  });
});

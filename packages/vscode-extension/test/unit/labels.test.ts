import { describe, expect, it } from 'vitest';
import type { ThreadState } from '@silykat/core';
import { outdatedQuote, threadLabel } from '../../src/labels';

const WORKTREE = { source: 'worktree', ref: null, sha: null } as ThreadState['anchor'];
const state = (over: Partial<ThreadState>): ThreadState =>
  ({
    status: 'open',
    lastAuthor: 'user',
    lastAgentName: null,
    onlyDrafts: false,
    anchor: WORKTREE,
    ...over,
  }) as ThreadState;

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

describe('threadLabel on a side of a diff', () => {
  it('names the version first', () => {
    const onIndex = { source: 'git', ref: '~', sha: null } as ThreadState['anchor'];
    const onHead = {
      source: 'git',
      ref: 'HEAD',
      sha: 'a92bf1ebf06d24c91791a89159ac0f0208895074',
    } as ThreadState['anchor'];
    expect(threadLabel(state({ anchor: onIndex }))).toBe('Index · Waiting for Claude');
    expect(threadLabel(state({ anchor: onHead, status: 'resolved' }))).toBe('HEAD a92bf1e');
    expect(threadLabel(state({ anchor: onIndex }), true)).toBe('⚠️ Outdated · Index · Waiting for Claude');
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

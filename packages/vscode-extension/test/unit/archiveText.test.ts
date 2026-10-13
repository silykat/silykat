import { describe, expect, it } from 'vitest';
import type { PurgePlan, ThreadHistory } from '@silykat/core';
import { archiveConfirmation, dayOf, purgeConfirmation, threadItemText } from '../../src/archiveText';

const thread = (over: Partial<ThreadHistory> = {}): ThreadHistory => ({
  id: 't_1',
  state: 'resolved',
  status: 'resolved',
  anchor: {
    path: 'src/a.ts',
    source: 'worktree',
    ref: null,
    sha: null,
    range: { startLine: 3, endLine: 4 },
    snippet: 'x',
    contextBefore: [],
    contextAfter: [],
  },
  branch: null,
  createdAt: '2026-09-01T10:00:00.000Z',
  lastActivityAt: '2026-09-02T10:00:00.000Z',
  deletedAt: null,
  archivedAt: null,
  resolvedAt: '2026-09-02T10:00:00.000Z',
  hasDrafts: false,
  deletedReason: null,
  readOnly: false,
  conversation: [
    { kind: 'comment', id: 'c1', author: 'user', body: 'Rename this\nand that', at: '2026-09-01T10:00:00.000Z' },
  ],
  bytes: 1000,
  ...over,
});
const plan = (n: number, kept: number, unread = 0, retro = true): PurgePlan => ({
  threads: Array.from({ length: n }, () => ({
    thread: thread(),
    store: { root: '/r', origin: 'root' },
    copies: [],
    live: 1,
  })),
  inProgress: Array.from({ length: kept }, () => ({
    thread: thread({ state: 'open' }),
    store: { root: '/r', origin: 'root' },
    copies: [],
    live: 1,
  })),
  unread: Array.from({ length: unread }, () => ({
    thread: thread(),
    store: { root: '/r', origin: 'root' },
    copies: [],
    live: 1,
  })),
  retro,
  bytes: n * 1000,
});

describe('texts of the archive and clean-up commands', () => {
  it('shows a thread in a list: place, state, archive date, first line of its first comment', () => {
    expect(threadItemText(thread({ archivedAt: '2026-10-03T08:00:00.000Z' }))).toEqual({
      label: 'src/a.ts:3',
      description: 'resolved · archived 2026-10-03',
      detail: 'Rename this',
    });
    const wholeFile = thread({ anchor: { ...thread().anchor, range: null }, conversation: [] });
    expect(threadItemText(wholeFile)).toEqual({ label: 'src/a.ts', description: 'resolved' });
  });

  it('writes a local day as people type it', () => {
    expect(dayOf(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('says how many threads before archiving them', () => {
    expect(archiveConfirmation(1, '2026-10-01')).toMatchObject({
      message: 'Archive 1 resolved thread?',
      action: 'Archive 1 Thread',
    });
    expect(archiveConfirmation(3, '30d').detail).toMatch(
      /^They were resolved before 30d\. Archived threads leave VS Code/,
    );
  });

  it('says how many threads before deleting them for good, and which are kept', () => {
    const one = purgeConfirmation(plan(1, 0), '2026-09-01');
    expect(one).toMatchObject({ message: 'Delete 1 thread permanently?', action: 'Delete 1 Thread' });
    expect(one.detail).toContain('1 finished thread (resolved, archived or deleted) with no activity since 2026-09-01');
    expect(one.detail).toContain('it will be gone from the history');
    expect(one.detail).not.toContain('kept');
    const many = purgeConfirmation(plan(4, 2), '90d');
    expect(many.message).toBe('Delete 4 threads permanently?');
    expect(many.detail).toContain('This cannot be undone');
    expect(many.detail).toContain('2 older threads still in progress are kept.');
    expect(purgeConfirmation(plan(2, 1), '90d').detail).toContain('1 older thread still in progress is kept.');
  });

  it('says which threads are kept for retros, or that there is no retro yet', () => {
    expect(purgeConfirmation(plan(1, 0, 2), '2026-09-01').detail).toContain(
      '2 finished threads not read by a retro yet are kept for the next one.',
    );
    expect(purgeConfirmation(plan(1, 0, 1), '2026-09-01').detail).toContain(
      '1 finished thread not read by a retro yet is kept for the next one.',
    );
    expect(purgeConfirmation(plan(1, 0, 0, false), '2026-09-01').detail).toContain(
      'No retro in these folders yet: no thread is kept for one.',
    );
  });
});

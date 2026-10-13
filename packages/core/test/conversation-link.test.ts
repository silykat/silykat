import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  analysisInput,
  buildAnchorContext,
  callFor,
  foldRetro,
  linkedSessions,
  sessionRefOf,
  SessionRegistry,
  Store,
  threadHistory,
  type Anchor,
  type RetroEvent,
  type ThreadEvent,
} from '../src';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'slk-core-link-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const anchor = (): Anchor => ({
  path: 'a.ts',
  source: 'worktree',
  ref: null,
  sha: null,
  ...buildAnchorContext('const a = 1;', { startLine: 1, endLine: 1 }),
});

describe('session references', () => {
  it('keeps a valid reference only', () => {
    expect(sessionRefOf({ id: 's1', message: 'm1' })).toEqual({ id: 's1', message: 'm1' });
    expect(sessionRefOf({ id: 's1', message: '' })).toEqual({ id: 's1' });
    expect(sessionRefOf({ id: 's1', message: 3 })).toEqual({ id: 's1' });
    expect(sessionRefOf({ id: ' ' })).toBeUndefined();
    expect(sessionRefOf({ id: 3 })).toBeUndefined();
    expect(sessionRefOf('s1')).toBeUndefined();
    expect(sessionRefOf(null)).toBeUndefined();
  });

  it('writes it on agent comments only', async () => {
    const store = new Store(dir);
    const t = await store.createThread(anchor(), { author: 'user', body: 'Hi', reviewId: null });
    await store.addComment(t.id, { author: 'user', body: 'Me', reviewId: null, session: { id: 'u' } });
    await store.addComment(t.id, {
      author: 'agent',
      agent: 'Claude',
      body: 'Done',
      reviewId: null,
      session: { id: 's1' },
    });
    const h = (await store.loadHistory()).threads[0]!;
    expect(h.conversation.map((e) => (e.kind === 'comment' ? (e.session ?? null) : null))).toEqual([
      null,
      null,
      { id: 's1' },
    ]);
    expect(linkedSessions(h)).toEqual(['s1']);
  });

  it('reads a reference written by any tool, and never one on a user comment', () => {
    const at = '2026-10-01T10:00:00.000Z';
    const events: ThreadEvent[] = [
      { v: 1, type: 'thread.created', at, by: 'user', threadId: 't_1', anchor: anchor() },
      { v: 1, type: 'comment.added', at, by: 'user', commentId: 'c1', body: 'x', reviewId: null, session: { id: 'u' } },
      {
        v: 1,
        type: 'comment.added',
        at,
        by: 'agent',
        agent: 'A',
        commentId: 'c2',
        body: 'y',
        reviewId: null,
        session: { id: 's1' },
      },
      {
        v: 1,
        type: 'comment.added',
        at,
        by: 'agent',
        agent: 'A',
        commentId: 'c3',
        body: 'z',
        reviewId: null,
        session: { id: 's1', message: 'm' },
      },
      {
        v: 1,
        type: 'comment.added',
        at,
        by: 'agent',
        agent: 'A',
        commentId: 'c4',
        body: 'w',
        reviewId: null,
        session: { id: 's2' },
      },
    ];
    const h = threadHistory(events)!;
    expect(linkedSessions(h)).toEqual(['s1', 's2']);
  });
});

describe('agent calls', () => {
  const NOW = Date.parse('2026-10-03T10:00:00.000Z');
  const call = (message: string, command: string, minutesAgo = 0) => ({
    message,
    command,
    at: new Date(NOW - minutesAgo * 60_000).toISOString(),
  });

  it('picks the latest recent call naming the thread, else the only recent call', () => {
    expect(callFor([call('a', 'slk review reply t_1'), call('b', 'slk review reply t_2')], 't_1', NOW)?.message).toBe(
      'a',
    );
    expect(
      callFor([call('a', 'slk review reply t_1', 2), call('b', 'slk review reply t_1', 1)], 't_1', NOW)?.message,
    ).toBe('b');
    expect(callFor([call('a', 'slk review reply "$ID"')], 't_1', NOW)?.message).toBe('a');
    expect(
      callFor([call('a', 'slk review reply "$ID"'), call('b', 'slk review reply "$OTHER"')], 't_1', NOW),
    ).toBeUndefined();
    expect(callFor([call('a', 'slk review reply t_1', 30)], 't_1', NOW)).toBeUndefined();
    expect(callFor([{ message: 'a', command: 'slk review reply t_1', at: 'not a date' }], 't_1', NOW)).toBeUndefined();
    expect(callFor([], 't_1', NOW)).toBeUndefined();
  });

  it('are kept per session until they end, and go with the session', async () => {
    const registry = new SessionRegistry(dir, () => true);
    expect(await registry.calls('s1')).toEqual([]); // no registry folder yet
    await registry.startCall('s1', call('toolu_1', 'slk review reply t_1'));
    await registry.startCall('s1', call('toolu_2', 'slk review reply t_2'));
    await registry.startCall('s2', call('toolu_3', 'slk review reply t_3'));
    expect((await registry.calls('s1')).map((c) => c.message).sort()).toEqual(['toolu_1', 'toolu_2']);
    await registry.endCall('s1', 'toolu_1');
    expect((await registry.calls('s1')).map((c) => c.message)).toEqual(['toolu_2']);
    await registry.unregister('s1');
    expect(await registry.calls('s1')).toEqual([]);
    expect(await registry.calls('s2')).toHaveLength(1);
    await expect(registry.startCall('s1', call('../x', 'slk review reply'))).rejects.toThrow('Invalid note key');
    await expect(registry.calls('../s')).rejects.toThrow('Invalid session id');
  });

  it('skips a call it cannot read', async () => {
    const registry = new SessionRegistry(dir, () => true);
    await registry.setNote('s1', 'call-broken', 'not json');
    await registry.setNote('s1', 'call-partial', JSON.stringify({ message: 'x' }));
    expect(await registry.calls('s1')).toEqual([]);
  });
});

describe('conversations in a retro', () => {
  const started: RetroEvent = {
    v: 1,
    at: '2026-10-03T10:00:00.000Z',
    type: 'retro.started',
    retroId: 'rt_01M3ZJXHW3J9AMCAVC0XB4A765',
    root: '/p',
    since: null,
    until: '2026-10-03T10:00:00.000Z',
    stores: [],
    threads: ['t_1', 't_2'],
    bytes: 0,
    preferences: [],
  };

  it('remembers which conversations were read back, and once read, keeps it', () => {
    const at = '2026-10-03T10:01:00.000Z';
    const r = foldRetro([
      started,
      { v: 1, at, type: 'retro.conversation', thread: 't_1', sessions: ['s1'], available: true },
      { v: 1, at, type: 'retro.conversation', thread: 't_1', sessions: ['s1'], available: false },
      { v: 1, at, type: 'retro.conversation', thread: 't_2', sessions: ['s0'], available: false },
    ])!;
    expect(r.conversations).toEqual({
      t_1: { sessions: ['s1'], available: true, at },
      t_2: { sessions: ['s0'], available: false, at },
    });
  });

  it("tells the analysis which threads have the agent's conversation linked", async () => {
    const store = new Store(dir);
    const linked = await store.createThread(anchor(), { author: 'user', body: 'Hi', reviewId: null });
    await store.addComment(linked.id, {
      author: 'agent',
      agent: 'Claude',
      body: 'Done',
      reviewId: null,
      session: { id: 's1' },
    });
    const plain = await store.createThread(anchor(), { author: 'user', body: 'Hey', reviewId: null });
    const threads = new Map((await store.loadHistory()).threads.map((t) => [t.id, { thread: t, store: dir }] as const));
    const retro = foldRetro([{ ...started, threads: [linked.id, plain.id] }])!;
    const text = analysisInput({ retro, threads, previous: [], preferences: [] });
    const block = (id: string) => text.slice(text.indexOf(`THREAD ${id}`)).split('\n\n')[0]!;
    expect(block(linked.id)).toContain("the agent's conversation is linked");
    expect(block(plain.id)).not.toContain('conversation');
  });
});

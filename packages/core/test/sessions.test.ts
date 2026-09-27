import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DeliveryQueue,
  localReviewHome,
  planDelivery,
  relevantSessions,
  routeThread,
  SessionRegistry,
  type Session,
  type SessionRecord,
} from '../src/index';

let home: string;
const alive = new Set<number>([1111, 2222]);
const registry = () => new SessionRegistry(home, (pid) => alive.has(pid));
const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  id: 'session-a',
  agent: 'Claude',
  cwd: '/repo/worktree-a',
  branch: 'feature-a',
  pid: 1111,
  startedAt: '2026-09-26T10:00:00.000Z',
  ...over,
});

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'lr-home-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('SessionRegistry', () => {
  it('registers, lists and unregisters sessions', async () => {
    const r = registry();
    expect(await r.list()).toEqual([]);
    await r.register(record());
    await r.register(record({ id: 'session-b', cwd: '/repo/worktree-b', branch: 'feature-b', pid: 2222 }));
    expect((await r.list()).map((s) => [s.id, s.branch])).toEqual([
      ['session-a', 'feature-a'],
      ['session-b', 'feature-b'],
    ]);
    await r.unregister('session-a');
    expect((await r.list()).map((s) => s.id)).toEqual(['session-b']);
  });

  it('refreshes a session registered again', async () => {
    const r = registry();
    await r.register(record());
    await r.register(record({ branch: 'renamed-branch' }));
    expect((await r.list()).map((s) => s.branch)).toEqual(['renamed-branch']);
  });

  it('removes sessions whose process is gone (a crash)', async () => {
    const r = registry();
    await r.register(record({ pid: 9999 }));
    expect(await r.list()).toEqual([]);
    expect(await readdir(r.dir)).toEqual([]);
  });

  it('keeps sessions with an unknown process', async () => {
    const r = registry();
    await r.register(record({ pid: null }));
    expect(await r.list()).toHaveLength(1);
  });

  it('records the files a session wrote, each once, most recent last', async () => {
    const r = registry();
    await r.register(record());
    await r.touch('session-a', '/repo/a.ts');
    await r.touch('session-a', '/specs/b.md');
    await r.touch('session-a', '/repo/a.ts');
    expect((await r.list())[0]!.touched).toEqual(['/specs/b.md', '/repo/a.ts']);
  });

  it('ignores unreadable records and rejects ids that could escape the folder', async () => {
    const r = registry();
    await r.register(record());
    await writeFile(join(r.dir, 'garbage.json'), '{not json');
    expect((await r.list()).map((s) => s.id)).toEqual(['session-a']);
    await expect(r.register(record({ id: '../../etc' }))).rejects.toThrow(/Invalid session id/);
  });
});

describe('localReviewHome', () => {
  it('uses LOCAL_REVIEW_HOME when set, else ~/.local-review', () => {
    expect(localReviewHome({ LOCAL_REVIEW_HOME: '/tmp/lr' })).toBe('/tmp/lr');
    expect(localReviewHome({})).toMatch(/\.local-review$/);
  });
});

describe('relevantSessions', () => {
  const s = (id: string, cwd: string, touched: string[] = []) => ({ ...record({ id, cwd }), touched });

  it('keeps sessions working in, above or below the folders, or that wrote a file in them', () => {
    const sessions = [
      s('inside', '/work/repo/packages/cli'),
      s('above', '/work'),
      s('same', '/work/repo'),
      s('specs-writer', '/elsewhere/code', ['/work/specs/plan.md']),
      s('unrelated', '/other/project', ['/other/project/a.ts']),
      s('prefix-only', '/work/repo-other'),
    ];
    expect(relevantSessions(sessions, ['/work/repo', '/work/specs']).map((x) => x.id)).toEqual([
      'inside',
      'above',
      'same',
      'specs-writer',
    ]);
  });
});

describe('Session inboxes', () => {
  const delivery = (id: string, threadIds = ['t_1']) => ({
    id,
    at: '2026-09-26T10:00:00.000Z',
    root: '/repo/worktree-a',
    kind: 'comment' as const,
    threadIds,
  });

  it('reads the deliveries appended since the last read', async () => {
    const r = registry();
    expect((await r.readInbox('session-a')).deliveries).toEqual([]);
    await r.deliver('session-a', delivery('d_1'));
    const first = await r.readInbox('session-a');
    expect(first.deliveries.map((d) => d.id)).toEqual(['d_1']);
    await r.deliver('session-a', delivery('d_2', ['t_2', 't_3']));
    await r.deliver('session-a', { ...delivery('d_3'), kind: 'review', reviewId: 'r_1' });
    const next = await r.readInbox('session-a', first.cursor);
    expect(next.deliveries).toEqual([
      delivery('d_2', ['t_2', 't_3']),
      { ...delivery('d_3'), kind: 'review', reviewId: 'r_1' },
    ]);
    expect(await r.readInbox('session-a', next.cursor)).toEqual({ deliveries: [], cursor: next.cursor });
  });

  it('leaves a line still being written for the next read, and skips corrupt lines', async () => {
    const r = registry();
    await r.deliver('session-a', delivery('d_1'));
    const file = join(home, 'sessions', 'session-a.inbox.jsonl');
    const { appendFile } = await import('node:fs/promises');
    await appendFile(file, 'not json\n{"id":"d_2","root":"/r","threadIds":["t');
    const read = await r.readInbox('session-a');
    expect(read.deliveries.map((d) => d.id)).toEqual(['d_1']);
    await appendFile(file, '_9"]}\n');
    expect((await r.readInbox('session-a', read.cursor)).deliveries.map((d) => [d.id, d.threadIds])).toEqual([
      ['d_2', ['t_9']],
    ]);
  });

  it('is removed with its session, and read again from the start if it was', async () => {
    const r = registry();
    await r.register(record());
    await r.deliver('session-a', delivery('d_1'));
    const { cursor } = await r.readInbox('session-a');
    await r.unregister('session-a');
    expect(await readdir(join(home, 'sessions'))).toEqual([]);
    await r.deliver('session-a', delivery('d_2'));
    expect((await r.readInbox('session-a', cursor)).deliveries.map((d) => d.id)).toEqual(['d_2']);
  });
});

describe('Routing published threads', () => {
  const at = (h: number) => `2026-09-26T${String(h).padStart(2, '0')}:00:00.000Z`;
  const s = (id: string, cwd: string, startedAt = at(9), writes: Record<string, number> = {}): Session => ({
    ...record({ id, cwd, startedAt }),
    touched: Object.keys(writes),
    writtenAt: Object.fromEntries(Object.entries(writes).map(([f, h]) => [f, at(h)])),
  });

  it('sends each worktree to its own session', () => {
    const sessions = [s('A', '/wt/a'), s('B', '/wt/b')];
    expect(routeThread(sessions, '/wt/a', '/wt/a/src/x.ts')).toEqual({ sure: true, session: sessions[0] });
    expect(routeThread(sessions, '/wt/b', '/wt/b/src/x.ts')).toEqual({ sure: true, session: sessions[1] });
  });

  it('sends a spec to the session that wrote it, wherever that session works', () => {
    const sessions = [s('A', '/wt/a', at(9), { '/specs/plan.md': 10 }), s('B', '/wt/b')];
    expect(routeThread(sessions, '/specs', '/specs/plan.md')).toMatchObject({ sure: true, session: { id: 'A' } });
  });

  it('prefers the writer over a session working there, and the closest folder over a parent one', () => {
    const sessions = [
      s('parent', '/work'),
      s('wt', '/work/wt-a'),
      s('writer', '/elsewhere', at(9), { '/work/wt-a/w.ts': 9 }),
    ];
    expect(routeThread(sessions, '/work/wt-a', '/work/wt-a/w.ts')).toMatchObject({ session: { id: 'writer' } });
    expect(routeThread(sessions, '/work/wt-a', '/work/wt-a/other.ts')).toMatchObject({
      sure: true,
      session: { id: 'wt' },
    });
  });

  it('follows where each session works now: two sessions started in the same parent folder', () => {
    const inWorktree = { ...s('W', '/work'), workingDir: '/work/wt-test' };
    const inMain = { ...s('M', '/work'), workingDir: '/work/main' };
    const sessions = [inWorktree, inMain];
    expect(routeThread(sessions, '/work/wt-test', '/work/wt-test/a.ts')).toMatchObject({
      sure: true,
      session: { id: 'W' },
    });
    expect(routeThread(sessions, '/work/main', '/work/main/a.ts')).toMatchObject({ sure: true, session: { id: 'M' } });
    expect(relevantSessions([{ ...s('X', '/elsewhere'), workingDir: '/work/main' }], ['/work/main'])).toHaveLength(1);
  });

  it('is in doubt when several sessions could be the one, and proposes the likeliest', () => {
    const same = [s('early', '/repo', at(8)), s('late', '/repo', at(11))];
    expect(routeThread(same, '/repo', '/repo/a.ts')).toMatchObject({ sure: false, proposed: { id: 'late' } });
    const writers = [
      s('first', '/repo', at(8), { '/repo/a.ts': 12 }),
      s('second', '/repo', at(11), { '/repo/a.ts': 10 }),
    ];
    expect(routeThread(writers, '/repo', '/repo/a.ts')).toMatchObject({ sure: false, proposed: { id: 'first' } });
  });

  it('falls back on a session working below the store, and finds none elsewhere', () => {
    expect(routeThread([s('sub', '/repo/pkg')], '/repo', '/repo/README.md')).toMatchObject({ sure: true });
    expect(routeThread([s('other', '/other')], '/repo', '/repo/a.ts')).toBeNull();
  });

  it('plans a publication: sure threads by session, one question for the doubtful ones, the rest waits', () => {
    const sessions = [s('A', '/repo', at(8), { '/repo/a.ts': 9 }), s('B', '/repo', at(10), { '/repo/b.ts': 9 })];
    const plan = planDelivery(
      [...sessions, s('C', '/repo/pkg', at(11))],
      '/repo',
      [
        { id: 't_a', file: '/repo/a.ts' },
        { id: 't_b', file: '/repo/b.ts' },
        { id: 't_c', file: '/repo/c.ts' },
      ],
      'A',
    );
    expect([...plan.sure]).toEqual([
      ['A', ['t_a']],
      ['B', ['t_b']],
    ]);
    expect(plan.doubt).toMatchObject({ threadIds: ['t_c'], proposed: { id: 'A' } }); // the last one used
    expect(plan.doubt!.candidates.map((c) => c.id)).toEqual(['A', 'B']);
    expect(planDelivery([], '/repo', [{ id: 't_a', file: '/repo/a.ts' }]).waiting).toEqual(['t_a']);
  });
});

describe('Moving sessions', () => {
  it('records the folder a session works in now, and its branch', async () => {
    const r = registry();
    await r.register(record({ cwd: '/work', branch: null }));
    await r.moveTo('session-a', '/work/wt-test', 'feature-w');
    expect(await r.list()).toMatchObject([{ cwd: '/work', workingDir: '/work/wt-test', branch: 'feature-w' }]);
    await r.moveTo('unknown', '/x', null); // no-op
    expect((await r.list()).map((x) => x.id)).toEqual(['session-a']);
  });
});

describe('DeliveryQueue', () => {
  it('keeps deliveries per folder until they are taken, once', async () => {
    const q = new DeliveryQueue(home);
    const d = (id: string, root: string) => ({ id, at: '', root, kind: 'comment' as const, threadIds: ['t_1'] });
    expect(await q.take('/repo')).toEqual([]);
    await q.add(d('d_1', '/repo'));
    await q.add(d('d_2', '/repo'));
    await q.add(d('d_3', '/specs'));
    expect((await q.peek('/repo')).map((x) => x.id)).toEqual(['d_1', 'd_2']);
    expect((await q.take('/repo')).map((x) => x.id)).toEqual(['d_1', 'd_2']);
    expect(await q.take('/repo')).toEqual([]);
    expect((await q.peek('/specs')).map((x) => x.id)).toEqual(['d_3']);
  });
});

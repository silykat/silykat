import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  filesChangedSince,
  localReviewHome,
  relevantSessions,
  SessionRegistry,
  subscribersOf,
  topicLabel,
  topicOf,
  type Session,
  type SessionRecord,
  type Subscription,
  type Topic,
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
  const s = (id: string, cwd: string, subscriptions: Subscription[] = []): Session => ({
    ...record({ id, cwd }),
    subscriptions,
  });
  const sub = (topic: Topic): Subscription => ({ topic, reason: 'modified', at: '' });

  it('keeps sessions started in, above or below the folders, or subscribed to something inside', () => {
    const sessions = [
      s('in', '/repo/worktree-a'),
      s('above', '/repo'),
      s('below', '/repo/worktree-a/pkg'),
      s('elsewhere', '/other'),
      s('subscribed', '/other', [sub({ kind: 'branch', repo: '/r/.git', branch: 'x', worktree: '/repo/worktree-a' })]),
      s('spec-writer', '/other', [sub({ kind: 'path', path: '/repo/worktree-a/plan.md' })]),
    ];
    expect(relevantSessions(sessions, ['/repo/worktree-a']).map((x) => x.id)).toEqual([
      'in',
      'above',
      'below',
      'subscribed',
      'spec-writer',
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

describe('Subscriptions', () => {
  const branch = (b: string): Topic => ({ kind: 'branch', repo: '/work/app/.git', branch: b, worktree: `/work/${b}` });

  it('subscribes once per topic, unsubscribes, and goes with the session', async () => {
    const r = registry();
    await r.register(record());
    expect(await r.subscribe('session-a', branch('feat'), 'modified')).toBe(true);
    expect(await r.subscribe('session-a', branch('feat'), 'user')).toBe(false); // already
    expect(await r.subscribe('session-a', { kind: 'path', path: '/specs/plan.md' }, 'modified')).toBe(true);
    expect((await r.list())[0]!.subscriptions.map((x) => [topicLabel(x.topic), x.reason])).toEqual([
      ['app · feat', 'modified'],
      ['/specs/plan.md', 'modified'],
    ]);
    expect((await r.unsubscribe('session-a', branch('feat'))).length).toBe(1);
    expect((await r.subscriptions('session-a')).map((x) => x.topic.kind)).toEqual(['path']);
    expect((await r.unsubscribe('session-a', 'all')).length).toBe(1);
    expect(await r.subscriptions('session-a')).toEqual([]);
    await r.subscribe('session-a', branch('feat'), 'launch');
    await r.unregister('session-a');
    expect(await readdir(r.dir)).toEqual([]);
  });

  it('publishes to every subscriber of the topic of a file', () => {
    const at = (id: string, ...subs: Topic[]): Session => ({
      ...record({ id }),
      subscriptions: subs.map((topic) => ({ topic, reason: 'modified' as const, at: '' })),
    });
    const sessions = [
      at('dev', branch('feat')),
      at('reviewer', branch('feat')),
      at('other', branch('main')),
      at('specs', { kind: 'path', path: '/specs' }),
    ];
    const ids = (file: string, topic: Topic) => subscribersOf(sessions, file, topic).map((x) => x.id);
    expect(ids('/work/feat/a.ts', branch('feat'))).toEqual(['dev', 'reviewer']);
    expect(ids('/work/main/a.ts', branch('main'))).toEqual(['other']);
    expect(ids('/specs/plan.md', { kind: 'path', path: '/specs/plan.md' })).toEqual(['specs']);
    expect(ids('/work/x/a.ts', branch('x'))).toEqual([]);
  });
});

describe('Topics', () => {
  it('are the branch of a git worktree (shared by its worktrees as one repo), else the path', async () => {
    const { execFileSync } = await import('node:child_process');
    const { mkdir, realpath, writeFile } = await import('node:fs/promises');
    const base = await realpath(await mkdtemp(join(tmpdir(), 'lr-topics-')));
    try {
      const repo = join(base, 'app');
      const g = (...args: string[]) =>
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd: repo });
      await mkdir(join(repo, 'src'), { recursive: true });
      g('init', '-q', '-b', 'main');
      await writeFile(join(repo, 'src', 'a.ts'), 'a');
      g('add', '.');
      g('commit', '-qm', 'init');
      g('worktree', 'add', '-q', '-b', 'feat', join(base, 'wt-feat'));

      const main = await topicOf(join(repo, 'src', 'a.ts'));
      const feat = await topicOf(join(base, 'wt-feat', 'src', 'new-file.ts')); // not there yet: its folder decides
      expect(main).toMatchObject({ kind: 'branch', branch: 'main', repo: join(repo, '.git'), worktree: repo });
      expect(feat).toMatchObject({ kind: 'branch', branch: 'feat', repo: join(repo, '.git') });
      expect(topicLabel(feat)).toBe('app · feat');
      expect(await topicOf(join(base, 'notes.md'))).toEqual({ kind: 'path', path: join(base, 'notes.md') });
      expect(await topicOf(join(repo, 'src'), { asPath: true })).toEqual({ kind: 'path', path: join(repo, 'src') });

      const since = Date.now() - 5000;
      await writeFile(join(base, 'wt-feat', 'src', 'b.ts'), 'b');
      expect(await filesChangedSince(join(base, 'wt-feat'), since)).toEqual([join(base, 'wt-feat', 'src', 'b.ts')]);
      expect(await filesChangedSince(base, since)).toEqual([]); // not git
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('Session notes', () => {
  it('keeps a note until it is taken, and drops notes with the session', async () => {
    const r = registry();
    await r.register(record());
    await r.setNote('session-a', 'bash-1', '123');
    expect(await r.takeNote('session-a', 'bash-1')).toBe('123');
    expect(await r.takeNote('session-a', 'bash-1')).toBeUndefined();
    await r.setNote('session-a', 'bash-2', '456');
    await r.unregister('session-a');
    expect(await readdir(join(home, 'sessions'))).toEqual([]);
    await expect(r.setNote('session-a', '../x', '1')).rejects.toThrow();
  });
});

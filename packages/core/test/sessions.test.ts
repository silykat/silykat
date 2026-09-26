import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localReviewHome, relevantSessions, SessionRegistry, type SessionRecord } from '../src/index';

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

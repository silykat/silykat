import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildAnchorContext,
  dateArgLabel,
  eraseHistory,
  eraseThread,
  historyPlan,
  parseDateArg,
  projectThreads,
  purgePlan,
  RetroBook,
  retroReading,
  saveWorktreeThreads,
  Store,
  type Anchor,
} from '../src/index';

const FILE = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
const anchor = (): Anchor => ({
  path: 'a.txt',
  source: 'worktree',
  ref: null,
  sha: null,
  ...buildAnchorContext(FILE, { startLine: 2, endLine: 2 }),
});
const at = (day: number) => `2026-09-${String(day).padStart(2, '0')}T10:00:00.000Z`;

let base: string;
const env = () => ({ SILYKAT_HOME: join(base, 'home'), HOME: join(base, 'user') });
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd, stdio: 'pipe' });
const comment = (root: string, body: string) =>
  new Store(root).createThread(anchor(), { author: 'user', body, reviewId: null });
const exists = async (path: string) => (await stat(path).catch(() => null)) !== null;

/** Rewrites the dates of a thread's journal: `day` of September for every event. */
async function backdate(store: Store, id: string, day: number): Promise<void> {
  const text = await readFile(store.threadFile(id), 'utf8');
  await writeFile(store.threadFile(id), text.replace(/"at":"[^"]+"/g, `"at":"${at(day)}"`));
}

/** A retro of `root` that read `threads`, up to `until`; finished unless said otherwise. */
async function retro(root: string, until: string, threads: string[], finished = true): Promise<void> {
  const book = new RetroBook(root);
  const r = await book.start({ root, since: null, until, stores: [], threads, bytes: 1 });
  if (finished) await book.record(r.id, [{ type: 'retro.finished' }]);
}

/** A resolved thread whose last activity is on `day` of September. */
async function resolved(root: string, body: string, day: number) {
  const store = new Store(root);
  const t = await comment(root, body);
  await store.setStatus(t.id, 'resolved', 'user');
  await backdate(store, t.id, day);
  return t;
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'slk-history-control-')));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('a clean-up does not get ahead of retros', () => {
  it('keeps nothing for retros in a project that never had one', async () => {
    await resolved(base, 'old', 2);
    expect(await retroReading([base])).toBeNull();
    const plan = purgePlan(await projectThreads([base], env()), new Date(at(20)), await retroReading([base]));
    expect(plan).toMatchObject({ retro: false, unread: [] });
    expect(plan.threads).toHaveLength(1);
  });

  it('keeps the threads active since the last retro, and those of a retro in progress', async () => {
    const read = await resolved(base, 'read by the last retro', 5);
    const after = await resolved(base, 'active after it', 12);
    const reading = await resolved(base, 'read by a retro in progress', 3);
    await retro(base, at(4), [reading.id, 'other'], false);
    await retro(base, at(10), [read.id]);

    const guard = await retroReading([base]);
    expect(guard).toEqual({ until: [at(10)], reading: new Set([reading.id, 'other']) });
    const plan = purgePlan(await projectThreads([base], env()), new Date(at(20)), guard);
    expect(plan.retro).toBe(true);
    expect(plan.threads.map((t) => t.thread.id)).toEqual([read.id]);
    expect(plan.unread.map((t) => t.thread.id).sort()).toEqual([after.id, reading.id].sort());
    expect(plan.bytes).toBe(plan.threads[0]!.thread.bytes);
  });

  it('keeps every thread while the only retro of the project is not finished', async () => {
    const t = await resolved(base, 'old', 2);
    await retro(base, at(4), [], false);
    const plan = purgePlan(await projectThreads([base], env()), new Date(at(20)), await retroReading([base]));
    expect(plan.threads).toEqual([]);
    expect(plan.unread.map((x) => x.thread.id)).toEqual([t.id]);
  });

  it('sees the retro of the folder above', async () => {
    const sub = join(base, 'api');
    await mkdir(sub);
    await retro(base, at(10), []);
    expect(await retroReading([sub])).toMatchObject({ until: [at(10)] });
  });
});

describe('erasing what the history keeps', () => {
  /** A repository whose worktree had threads saved, then was removed. */
  async function repoWithSavedWorktree() {
    const main = join(base, 'main');
    const wt = join(base, 'wt');
    await mkdir(main, { recursive: true });
    git(main, 'init', '-q', '-b', 'main');
    await writeFile(join(main, 'a.txt'), FILE);
    git(main, 'add', '.');
    git(main, 'commit', '-q', '-m', 'init');
    git(main, 'worktree', 'add', '-q', '-b', 'feat', wt);
    const inWt = await comment(wt, 'in the worktree');
    await saveWorktreeThreads(wt, env());
    return { main, wt, inWt };
  }

  it('erases a deleted thread for good, its copies saved from worktrees included', async () => {
    const { main, wt, inWt } = await repoWithSavedWorktree();
    const store = new Store(wt);
    await store.deleteThread(inWt.id, 'user');
    await eraseThread(store, inWt.id, env());
    expect(await exists(store.threadFile(inWt.id))).toBe(false);
    expect(await projectThreads([main, wt], env())).toEqual([]);
    // Erasing it again finds nothing, and says nothing.
    await expect(eraseThread(store, inWt.id, env())).resolves.toBeUndefined();
  });

  it('erases the deleted threads and the copies of worktree threads, and keeps the others', async () => {
    const { main, wt, inWt } = await repoWithSavedWorktree();
    git(main, 'worktree', 'remove', '--force', wt);
    const store = new Store(main);
    const kept = await comment(main, 'still open');
    const deleted = await comment(main, 'deleted');
    await store.deleteThread(deleted.id, 'user');

    const plan = await historyPlan([main], env());
    expect(plan.deleted.map((t) => t.thread.id)).toEqual([deleted.id]);
    expect(plan.saved.map((s) => s.saved!.worktree)).toEqual([wt]);
    expect(await eraseHistory(plan)).toEqual({ threads: 1, saved: 1 });

    expect((await projectThreads([main], env())).map((t) => t.thread.id)).toEqual([kept.id]);
    expect(await readdir(join(main, '.silykat', 'saved'))).toEqual([]);
    expect((await projectThreads([main], env())).some((t) => t.thread.id === inWt.id)).toBe(false);
    expect(await historyPlan([main], env())).toEqual({ deleted: [], saved: [] });
    expect(await eraseHistory({ deleted: [], saved: plan.saved })).toEqual({ threads: 0, saved: 0 });
  });
});

describe('dates as people read them', () => {
  it('says a number of days as the day it means, with the number of days', () => {
    const now = new Date(2026, 9, 3, 12).getTime();
    expect(dateArgLabel('60d', parseDateArg('60d', now)!)).toBe('2026-08-04 (60 days)');
    expect(dateArgLabel('1d', parseDateArg('1d', now)!)).toBe('2026-10-02 (1 day)');
    expect(dateArgLabel('2026-09-15', parseDateArg('2026-09-15')!)).toBe('2026-09-15');
    expect(dateArgLabel('2026-09-15T08:30:00', parseDateArg('2026-09-15T08:30:00')!)).toBe('2026-09-15 08:30');
  });
});

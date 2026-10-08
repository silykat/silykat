import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  analysisInput,
  buildAnchorContext,
  RetroBook,
  retroThreads,
  configFile,
  countDeletions,
  deletionLabel,
  expandHome,
  parseOrigin,
  projectHistory,
  readConfig,
  resolveWorktree,
  saveWorktreeThreads,
  savedStores,
  Store,
  threadHistory,
  worktreeInfo,
  worktreeThreadCount,
  writeConfig,
  type Anchor,
  type ThreadEvent,
} from '../src/index';

const FILE = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
const anchor = (): Anchor => ({
  path: 'a.txt',
  source: 'worktree',
  ref: null,
  sha: null,
  ...buildAnchorContext(FILE, { startLine: 2, endLine: 2 }),
});
const at = (minute: number) => `2026-09-26T10:${String(minute).padStart(2, '0')}:00.000Z`;
const created: ThreadEvent = { v: 1, type: 'thread.created', at: at(0), by: 'user', threadId: 't_1', anchor: anchor() };
const added: ThreadEvent = {
  v: 1,
  type: 'comment.added',
  at: at(0),
  by: 'user',
  commentId: 'c1',
  body: 'b',
  reviewId: null,
};

let base: string;
const env = () => ({ LOCAL_REVIEW_HOME: join(base, 'home'), HOME: join(base, 'user') });
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd, stdio: 'pipe' })
    .toString()
    .trim();
const comment = (root: string, body: string, reviewId: string | null = null) =>
  new Store(root).createThread(anchor(), { author: 'user', body, reviewId });

/** A repository with a commit, its store ignored by git, and a linked worktree next to it. */
async function repoWithWorktree(): Promise<{ main: string; wt: string }> {
  const main = join(base, 'main');
  const wt = join(base, 'wt');
  await mkdir(main, { recursive: true });
  git(main, 'init', '-q', '-b', 'main');
  await writeFile(join(main, 'a.txt'), FILE);
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'init');
  git(main, 'worktree', 'add', '-q', '-b', 'feat', wt);
  return { main, wt };
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'lr-keep-')));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('why a thread was deleted', () => {
  it('records the reason: removed by the user, or with its branch', async () => {
    const store = new Store(base);
    const removed = await comment(base, 'removed');
    const withBranch = await comment(base, 'branch');
    const last = await comment(base, 'last comment deleted');
    await store.deleteThread(removed.id, 'user');
    await store.deleteThread(withBranch.id, 'user', 'branch-gone');
    await store.deleteComment(last.id, last.comments[0]!.id, 'user');
    const { threads } = await store.loadHistory();
    const reason = (id: string) => threads.find((t) => t.id === id)!.deletedReason;
    expect([reason(removed.id), reason(withBranch.id), reason(last.id)]).toEqual(['user', 'branch-gone', 'user']);
    expect(threads.find((t) => t.id === withBranch.id)!.conversation.at(-1)).toMatchObject({
      kind: 'deleted',
      reason: 'branch-gone',
    });
    expect(countDeletions(threads)).toEqual({ user: 2, 'branch-gone': 1, unknown: 0 });
    const journal = await readFile(store.threadFile(withBranch.id), 'utf8');
    expect(journal).toContain('"reason":"branch-gone"');
    expect(journal).toContain('"v":1'); // an optional field: the format version does not change
  });

  it('reads older journals without a reason, and tells the obvious case', () => {
    const plain = threadHistory([created, added, { v: 1, type: 'thread.deleted', at: at(5), by: 'user' }])!;
    expect(plain.deletedReason).toBeNull();
    expect(plain.conversation.at(-1)).toEqual({ kind: 'deleted', by: 'user', at: at(5) });
    // The last comment deleted in the same write: the user removed it.
    const lastComment = threadHistory([
      created,
      added,
      { v: 1, type: 'comment.deleted', at: at(6), by: 'user', commentId: 'c1' },
      { v: 1, type: 'thread.deleted', at: at(6), by: 'user' },
    ])!;
    expect(lastComment.deletedReason).toBe('user');
    // Even older ones: every comment deleted, without the thread's event.
    const noEvent = threadHistory([
      created,
      added,
      { v: 1, type: 'comment.deleted', at: at(7), by: 'user', commentId: 'c1' },
    ])!;
    expect([noEvent.state, noEvent.deletedReason]).toEqual(['deleted', 'user']);
    expect(threadHistory([created, added])!.deletedReason).toBeNull();
    expect(countDeletions([plain, lastComment])).toEqual({ user: 1, 'branch-gone': 0, unknown: 1 });
  });

  it('reads a reason it does not know (written by a newer version) as unknown', () => {
    const future = threadHistory([
      created,
      added,
      { v: 1, type: 'thread.deleted', at: at(5), by: 'user', reason: 'merged' } as unknown as ThreadEvent,
    ])!;
    expect(future.deletedReason).toBeNull();
    expect(future.conversation.at(-1)).toEqual({ kind: 'deleted', by: 'user', at: at(5) });
    expect(countDeletions([future])).toEqual({ user: 0, 'branch-gone': 0, unknown: 1 });
  });

  it('labels the reasons for people', () => {
    expect(deletionLabel('user')).toBe('removed by the user');
    expect(deletionLabel('branch-gone')).toBe('its branch was deleted');
    expect(deletionLabel(undefined)).toBe('reason unknown');
  });
});

describe('machine settings', () => {
  it('keeps the history by default, and remembers a change', async () => {
    expect(await readConfig(env())).toMatchObject({ keepHistory: true });
    expect(await writeConfig({ keepHistory: false }, env())).toMatchObject({ keepHistory: false });
    expect(await readConfig(env())).toMatchObject({ keepHistory: false });
    expect(configFile(env())).toBe(join(base, 'home', 'config.json'));
  });

  it('keeps settings it does not know, and falls back to the defaults on a broken file', async () => {
    await mkdir(join(base, 'home'), { recursive: true });
    await writeFile(configFile(env()), '{"later": 1, "keepHistory": "no"}');
    expect(await readConfig(env())).toMatchObject({ keepHistory: true });
    await writeConfig({ keepHistory: false }, env());
    expect(JSON.parse(await readFile(configFile(env()), 'utf8'))).toEqual({ later: 1, keepHistory: false });
    await writeFile(configFile(env()), 'not json');
    expect(await readConfig(env())).toMatchObject({ keepHistory: true });
    await writeConfig({ keepHistory: false }, env());
    expect(await readConfig(env())).toMatchObject({ keepHistory: false });
  });

  it('loses no change when several are written at once', async () => {
    await Promise.all([
      writeConfig({ retroReminderDays: 12 }, env()),
      writeConfig({ retroReminderMaxDays: 9 }, env()),
      writeConfig({ retroReminderSizeKB: 5 }, env()),
      writeConfig({ keepHistory: false }, env()),
      writeConfig({ retroReminderMaxDays: 25 }, env()),
    ]);
    expect(await readConfig(env())).toEqual({
      keepHistory: false,
      retroReminder: true,
      retroReminderDays: 12,
      retroReminderSizeKB: 5,
      retroReminderMaxDays: 25,
      retroSessions: 'reports',
      retroSourceReviews: 'ask',
      retroSourceSessions: 'ask',
      retroSourceAudit: 'ask',
    });
    // A failed write does not stop the next ones.
    await writeFile(join(base, 'blocker'), '');
    await expect(writeConfig({ retroReminder: false }, { LOCAL_REVIEW_HOME: join(base, 'blocker') })).rejects.toThrow();
    expect(await writeConfig({ retroReminder: false }, env())).toMatchObject({ retroReminder: false });
  });
});

describe('git worktrees', () => {
  it('tells a linked worktree from the main one', async () => {
    const { main, wt } = await repoWithWorktree();
    await mkdir(join(wt, 'sub'));
    expect(await worktreeInfo(join(wt, 'sub'))).toMatchObject({ worktree: wt, linked: true, main, branch: 'feat' });
    expect(await worktreeInfo(main)).toMatchObject({ worktree: main, linked: false, main, branch: 'main' });
    expect(await worktreeInfo(base)).toBeNull();
  });

  it('finds the worktree a removal names: a path, or the end of one', async () => {
    const { main, wt } = await repoWithWorktree();
    expect(await resolveWorktree(main, '../wt')).toBe(wt);
    await rm(wt, { recursive: true, force: true }); // still registered in git
    expect(await resolveWorktree(main, 'wt')).toBe(wt);
    expect(await resolveWorktree(main, 'nope')).toBeNull();
    expect(expandHome('~/x', { HOME: '/h' })).toBe('/h/x');
    expect(expandHome('~', { HOME: '/h' })).toBe('/h');
    expect(expandHome('x/~', { HOME: '/h' })).toBe('x/~');
  });

  it("saves a worktree's threads to the main store, where the history finds them after its removal", async () => {
    const { main, wt } = await repoWithWorktree();
    const kept = await comment(wt, 'in the worktree');
    await new Store(wt).deleteThread((await comment(wt, 'removed')).id, 'user');
    const sub = join(wt, 'pkg');
    await comment(sub, 'in a folder of the worktree');
    const draftsOnly = await new Store(wt).startReview(null, '.');
    await comment(wt, 'a draft', draftsOnly.id);

    const saved = await saveWorktreeThreads(join(wt, 'pkg'), env());
    expect(saved).toMatchObject({ worktree: wt, branch: 'feat', main, threads: 4, published: 3 });
    expect(saved.copies.map((c) => [c.from, c.threads, c.published])).toEqual([
      [wt, 3, 2],
      [sub, 1, 1],
    ]);
    // The main store is ignored by git, as the editor does.
    expect(await readFile(join(main, '.git', 'info', 'exclude'), 'utf8')).toContain('.local-review/');
    expect(await worktreeThreadCount(wt, env())).toBe(3);

    git(main, 'worktree', 'remove', '--force', wt);
    const h = await projectHistory(main, { env: env() });
    const savedStore = h.stores.filter((s) => s.origin === 'saved');
    expect(savedStore.map((s) => [s.root, s.threads.length])).toEqual([
      [wt, 2],
      [sub, 1],
    ]);
    expect(savedStore[0]!.saved).toMatchObject({ worktree: wt, branch: 'feat' });
    expect(h.threads).toBe(3);
    expect(savedStore[0]!.threads.map((t) => [t.id, t.conversation[0]])).toContainEqual([
      kept.id,
      expect.objectContaining({ body: 'in the worktree' }),
    ]);
    expect(h.deletions).toEqual({ user: 1, 'branch-gone': 0, unknown: 0 });
  });

  it('refreshes the copy when saved again, and counts each thread once while the worktree exists', async () => {
    const { main, wt } = await repoWithWorktree();
    const t = await comment(wt, 'first');
    const first = await saveWorktreeThreads(wt, env());
    await new Store(wt).addComment(t.id, { author: 'agent', agent: 'Claude', body: 'done', reviewId: null });

    // Saved before the reply: the worktree's journal is the longer one, so it wins.
    let h = await projectHistory(main, { env: env() });
    expect(h.threads).toBe(1);
    expect(h.stores.map((s) => s.origin)).toEqual(['root', 'worktree']);
    expect(h.stores[1]!.threads[0]!.conversation).toHaveLength(2);

    const [before] = await savedStores(join(main, '.local-review'));
    await new Promise((r) => setTimeout(r, 5));
    const again = await saveWorktreeThreads(wt, env());
    const [slot] = await savedStores(join(main, '.local-review'));
    expect(slot!.firstSavedAt).toBe(before!.firstSavedAt);
    expect(slot!.savedAt > before!.savedAt).toBe(true);
    expect(again.copies[0]!.dir).toBe(first.copies[0]!.dir);
    h = await projectHistory(wt, { env: env() });
    expect(h.threads).toBe(1);
  });

  it('refuses the main worktree, a folder outside git, and does nothing for a worktree without comments', async () => {
    const { main, wt } = await repoWithWorktree();
    await expect(saveWorktreeThreads(main, env())).rejects.toThrow(/main worktree/);
    await expect(saveWorktreeThreads(base, env())).rejects.toThrow(/not in a git repository/);
    expect(await saveWorktreeThreads(wt, env())).toMatchObject({ copies: [], threads: 0 });
    expect(await savedStores(join(main, '.local-review'))).toEqual([]);
  });

  it('reads only well-formed origins', () => {
    expect(parseOrigin('nope')).toBeNull();
    expect(parseOrigin('null')).toBeNull();
    expect(parseOrigin('{"worktree":"/w"}')).toBeNull();
    expect(parseOrigin('{"worktree":"/w","root":"/w","repo":"/r/.git","savedAt":"x"}')).toEqual({
      worktree: '/w',
      root: '/w',
      repo: '/r/.git',
      branch: null,
      firstSavedAt: 'x',
      savedAt: 'x',
    });
  });
});

describe('the retro', () => {
  it('reads saved threads, and tells a thread removed by the user from one gone with its branch', async () => {
    const { main, wt } = await repoWithWorktree();
    const saved = await comment(wt, 'saved before the removal');
    await saveWorktreeThreads(wt, env());
    git(main, 'worktree', 'remove', '--force', wt);
    const removed = await comment(main, 'never mind');
    const merged = await comment(main, 'done with the branch');
    await new Store(main).deleteThread(removed.id, 'user');
    await new Store(main).deleteThread(merged.id, 'user', 'branch-gone');

    const book = new RetroBook(main);
    const r = await book.start({
      root: main,
      since: null,
      until: new Date().toISOString(),
      stores: [{ root: main, origin: 'root', threads: 3, bytes: 1 }],
      threads: [saved.id, removed.id, merged.id],
      bytes: 1,
    });
    const { threads } = await retroThreads(r, env());
    expect(threads.get(saved.id)?.store).toBe(`${wt} (saved before its git worktree was removed)`);
    const text = analysisInput({ retro: r, threads, previous: [], preferences: [] });
    expect(text).toContain(
      'deleted: 2 (removed by the user: 1; with their branch, once the work was done: 1; older, reason unknown: 0)',
    );
    expect(text).toContain('(thread deleted, removed by the user,');
    expect(text).toContain('(thread deleted, its branch was deleted,');
    expect(text).toContain('saved before the removal');
  });
});

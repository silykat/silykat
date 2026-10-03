import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agentView,
  archivedThreads,
  archiveThreads,
  buildAnchorContext,
  eventVersion,
  foldThread,
  historyJson,
  isFinished,
  parseDateArg,
  parseJournal,
  projectHistory,
  projectThreads,
  purgePlan,
  purgeThreads,
  resolvedBefore,
  saveWorktreeThreads,
  SCHEMA_VERSION,
  Store,
  threadHistory,
  unarchiveThreads,
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
const at = (day: number) => `2026-09-${String(day).padStart(2, '0')}T10:00:00.000Z`;
const created: ThreadEvent = { v: 1, type: 'thread.created', at: at(1), by: 'user', threadId: 't_1', anchor: anchor() };
const added: ThreadEvent = {
  v: 1,
  type: 'comment.added',
  at: at(1),
  by: 'user',
  commentId: 'c1',
  body: 'Rename this',
  reviewId: null,
};

let base: string;
const env = () => ({ LOCAL_REVIEW_HOME: join(base, 'home'), HOME: join(base, 'user') });
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd, stdio: 'pipe' });
const comment = (root: string, body: string) =>
  new Store(root).createThread(anchor(), { author: 'user', body, reviewId: null });
const lines = async (store: Store, id: string) =>
  (await readFile(store.threadFile(id), 'utf8'))
    .trimEnd()
    .split('\n')
    .map((l) => JSON.parse(l) as { v: number; type: string });

/** Rewrites the dates of a thread's journal: `day` of September for every event. */
async function backdate(store: Store, id: string, day: number): Promise<void> {
  const text = await readFile(store.threadFile(id), 'utf8');
  await writeFile(store.threadFile(id), text.replace(/"at":"[^"]+"/g, `"at":"${at(day)}"`));
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'lr-archive-')));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('archiving a thread', () => {
  it('hides it from the editor and agents, keeps it in the history, and brings it back', async () => {
    const store = new Store(base);
    const t = await comment(base, 'Rename this');
    await store.setStatus(t.id, 'resolved', 'user');

    const archived = await store.archiveThread(t.id);
    expect(archived).toMatchObject({ archived: true, status: 'resolved', deleted: false });
    expect(archived.archivedAt).not.toBeNull();
    expect(agentView(archived)).toBeNull();
    expect((await store.loadAll()).threads).toEqual([]);
    const [h] = (await store.loadHistory()).threads;
    expect(h).toMatchObject({ id: t.id, state: 'resolved', archivedAt: archived.archivedAt });
    expect(h!.resolvedAt).not.toBeNull();
    // Archiving is housekeeping, not feedback: the thread's last activity does not move.
    expect(h!.lastActivityAt).toBe(h!.resolvedAt);
    expect(await store.archiveThread(t.id)).toMatchObject({ archivedAt: archived.archivedAt }); // no-op

    const back = await store.unarchiveThread(t.id);
    expect(back).toMatchObject({ archived: false, archivedAt: null, status: 'resolved' });
    expect((await store.loadAll()).threads.map((x) => x.id)).toEqual([t.id]);
    expect((await store.loadHistory()).threads[0]!.archivedAt).toBeNull();
    expect((await store.unarchiveThread(t.id)).archived).toBe(false); // no-op
  });

  it('writes the archive events in format 2 and every other event in format 1', async () => {
    const store = new Store(base);
    const t = await comment(base, 'Rename this');
    await store.archiveThread(t.id);
    await store.unarchiveThread(t.id);
    await store.setStatus(t.id, 'resolved', 'user');
    expect((await lines(store, t.id)).map((l) => [l.type, l.v])).toEqual([
      ['thread.created', 1],
      ['comment.added', 1],
      ['thread.archived', 2],
      ['thread.unarchived', 2],
      ['status.changed', 1],
    ]);
    expect(eventVersion('comment.added')).toBe(1);
    expect(eventVersion('review.submitted')).toBe(1);
    expect(eventVersion('thread.archived')).toBe(SCHEMA_VERSION);
  });

  it('refuses changes to an archived thread until it is unarchived', async () => {
    const store = new Store(base);
    const t = await comment(base, 'Rename this');
    await store.archiveThread(t.id);
    await expect(store.addComment(t.id, { author: 'user', body: 'more', reviewId: null })).rejects.toThrow(
      /is archived: unarchive it first/,
    );
    await expect(store.deleteThread(t.id, 'user')).rejects.toThrow(/is archived/);
    // Agents do not see it at all.
    await expect(
      store.addComment(t.id, { author: 'agent', agent: 'Claude', body: 'done', reviewId: null }),
    ).rejects.toThrow(/Thread not found/);
    await store.unarchiveThread(t.id);
    await expect(store.addComment(t.id, { author: 'user', body: 'more', reviewId: null })).resolves.toBeTruthy();
  });

  it('archives neither deleted threads, nor threads holding only drafts, nor threads of a newer version', async () => {
    const store = new Store(base);
    const gone = await comment(base, 'gone');
    await store.deleteThread(gone.id, 'user');
    await expect(store.archiveThread(gone.id)).rejects.toThrow(/Thread not found/);

    const review = await store.startReview();
    const draft = await store.createThread(anchor(), { author: 'user', body: 'draft', reviewId: review.id });
    await expect(store.archiveThread(draft.id)).rejects.toThrow(/only drafts/);

    const newer = await comment(base, 'newer');
    await writeFile(store.threadFile(newer.id), '{"v":99,"type":"thread.archived","at":"x","by":"user"}\n', {
      flag: 'a',
    });
    await expect(store.archiveThread(newer.id)).rejects.toThrow(/newer version/);
  });

  it('ignores an archive event that the user did not write', () => {
    const byAgent = (type: 'thread.archived' | 'thread.unarchived'): ThreadEvent => ({
      v: 2,
      type,
      at: at(2),
      by: 'agent',
      agent: 'Claude',
    });
    expect(foldThread([created, added, byAgent('thread.archived')])!.archived).toBe(false);
    expect(threadHistory([created, added, byAgent('thread.archived')])!.archivedAt).toBeNull();
    const user: ThreadEvent = { v: 2, type: 'thread.archived', at: at(2), by: 'user' };
    expect(foldThread([created, added, user, byAgent('thread.unarchived')])!.archived).toBe(true);
    expect(threadHistory([created, added, user, byAgent('thread.unarchived')])!.archivedAt).toBe(at(2));
  });

  it('reads archive events (format 2), and keeps a thread of a later format read-only', () => {
    const text = JSON.stringify(created) + '\n' + JSON.stringify(added) + '\n';
    const archived = text + '{"v":2,"type":"thread.archived","at":"2026-09-02T10:00:00.000Z","by":"user"}\n';
    const parsed = parseJournal(archived);
    expect(parsed).toMatchObject({ futureVersion: false, warnings: [] });
    expect(foldThread(parsed.events)!.archived).toBe(true);
    const later = parseJournal(text + '{"v":3,"type":"thread.archived","at":"x","by":"user"}\n');
    expect(later.futureVersion).toBe(true);
    expect(foldThread(later.events, { futureVersion: true })).toMatchObject({ readOnly: true, archived: false });
  });
});

describe('migrating a store to format 2', () => {
  it('records version 2 at the first write of this version, and never lowers a newer one', async () => {
    const store = new Store(base);
    await mkdir(store.threadsDir, { recursive: true });
    await writeFile(join(store.dir, 'schema-version'), '1\n');
    // A thread of the first format, as an older version wrote it: still read as it is.
    await writeFile(
      join(store.threadsDir, 't_01JAAAAAAAAAAAAAAAAAAAAAAA.jsonl'),
      [created, added].map((e) => JSON.stringify({ ...e, threadId: 't_01JAAAAAAAAAAAAAAAAAAAAAAA' })).join('\n') + '\n',
    );
    expect(await store.schemaVersion()).toBe(1);
    expect((await store.loadAll()).threads).toHaveLength(1);
    expect(await store.schemaVersion()).toBe(1); // reading never migrates

    await store.archiveThread('t_01JAAAAAAAAAAAAAAAAAAAAAAA');
    expect(await readFile(join(store.dir, 'schema-version'), 'utf8')).toBe('2\n');
    expect((await readdir(store.dir)).sort()).toEqual(['reviews', 'schema-version', 'threads']);

    await writeFile(join(store.dir, 'schema-version'), '3\n');
    await comment(base, 'another');
    expect(await store.schemaVersion()).toBe(3);
    await writeFile(join(store.dir, 'schema-version'), 'garbage');
    expect(await store.schemaVersion()).toBeNull();
    await comment(base, 'repairs it');
    expect(await store.schemaVersion()).toBe(2);
  });
});

describe('managing the threads of a project', () => {
  it('archives the threads resolved before a date, lists them, and brings them back', async () => {
    const store = new Store(base);
    const old = await comment(base, 'old and resolved');
    await store.setStatus(old.id, 'resolved', 'user');
    await backdate(store, old.id, 5);
    const recent = await comment(base, 'resolved recently');
    await store.setStatus(recent.id, 'resolved', 'user');
    const open = await comment(base, 'still open');
    await backdate(store, open.id, 2);

    const threads = await projectThreads([base], env());
    const selected = resolvedBefore(threads, new Date(at(20)));
    expect(selected.map((t) => t.thread.id)).toEqual([old.id]);
    expect(await archiveThreads(selected)).toEqual({ done: [old.id], unchanged: [], failed: [] });
    // Archiving it again changes nothing, and says so.
    expect(await archiveThreads(selected)).toEqual({ done: [], unchanged: [old.id], failed: [] });

    const after = await projectThreads([base], env());
    expect(archivedThreads(after).map((t) => t.thread.id)).toEqual([old.id]);
    await store.archiveThread(open.id);
    const two = archivedThreads(await projectThreads([base], env()));
    expect(two.map((t) => t.thread.id)).toEqual([open.id, old.id]); // the last archived first
    await store.unarchiveThread(open.id);
    expect(resolvedBefore(after, new Date(at(20)))).toEqual([]); // already archived
    expect((await store.loadAll()).threads.map((t) => t.id).sort()).toEqual([recent.id, open.id].sort());

    const h = await projectHistory(base, { env: env() });
    expect(h).toMatchObject({ threads: 3, archived: 1 });
    const json = historyJson(h);
    expect(json.summary.archived).toBe(1);
    expect(json.threads.find((t) => t.id === old.id)).toMatchObject({ archivedAt: expect.any(String) });
    expect(json.threads.find((t) => t.id === open.id)).toMatchObject({ archivedAt: null, resolvedAt: null });

    expect(await unarchiveThreads(archivedThreads(after))).toEqual({ done: [old.id], unchanged: [], failed: [] });
    expect((await store.loadAll()).threads).toHaveLength(3);
    expect(await unarchiveThreads(archivedThreads(after))).toEqual({ done: [], unchanged: [old.id], failed: [] });
  });

  it('reports a thread it could not change', async () => {
    const store = new Store(base);
    const t = await comment(base, 'deleted meanwhile');
    const [found] = await projectThreads([base], env());
    await store.deleteThread(t.id, 'user');
    expect(await archiveThreads([found!])).toEqual({
      done: [],
      unchanged: [],
      failed: [{ id: t.id, error: `Thread not found: ${t.id}` }],
    });
  });

  it('plans a purge of the finished threads with nothing published since a date, and keeps those in progress', async () => {
    const store = new Store(base);
    const resolved = await comment(base, 'resolved');
    await store.setStatus(resolved.id, 'resolved', 'user');
    const deleted = await comment(base, 'deleted');
    await store.deleteThread(deleted.id, 'user');
    const archivedOpen = await comment(base, 'archived while open');
    await store.archiveThread(archivedOpen.id);
    const inProgress = await comment(base, 'still waiting for the agent');
    const recent = await comment(base, 'resolved, but recent');
    await store.setStatus(recent.id, 'resolved', 'user');
    for (const t of [resolved, deleted, archivedOpen, inProgress]) await backdate(store, t.id, 3);

    const plan = purgePlan(await projectThreads([base], env()), new Date(at(10)));
    expect(plan.threads.map((t) => t.thread.id).sort()).toEqual([resolved.id, deleted.id, archivedOpen.id].sort());
    expect(plan.inProgress.map((t) => t.thread.id)).toEqual([inProgress.id]);
    expect(plan.bytes).toBeGreaterThan(0);
    expect(isFinished(plan.inProgress[0]!.thread)).toBe(false);

    expect((await purgeThreads(plan.threads)).done).toHaveLength(3);
    const left = await projectThreads([base], env());
    expect(left.map((t) => t.thread.id).sort()).toEqual([inProgress.id, recent.id].sort());
    expect(await store.purgeThread(resolved.id)).toBe(false); // already gone
  });

  it('acts on every copy of a thread saved from a worktree, and counts it once', async () => {
    const main = join(base, 'main');
    const wt = join(base, 'wt');
    await mkdir(main, { recursive: true });
    git(main, 'init', '-q', '-b', 'main');
    await writeFile(join(main, 'a.txt'), FILE);
    git(main, 'add', '.');
    git(main, 'commit', '-q', '-m', 'init');
    git(main, 'worktree', 'add', '-q', '-b', 'feat', wt);
    const inWt = new Store(wt);
    const t = await comment(wt, 'in the worktree');
    await inWt.setStatus(t.id, 'resolved', 'user');
    await saveWorktreeThreads(wt, env());

    const threads = await projectThreads([main, wt], env());
    expect(threads).toHaveLength(1);
    expect(threads[0]!.copies).toHaveLength(2);
    expect(threads[0]!.store.origin).not.toBe('saved'); // the live journal first

    expect(threads[0]!.live).toBe(1);

    // Archived where it lives: the copy keeps the state of when it was saved.
    await archiveThreads(threads);
    const [live, copy] = (await projectThreads([main], env()))[0]!.copies;
    expect((await live!.loadHistory()).threads[0]!.archivedAt).not.toBeNull();
    expect((await copy!.loadHistory()).threads[0]!.archivedAt).toBeNull();
    expect((await projectThreads([main], env()))[0]!.thread.archivedAt).not.toBeNull(); // the longest journal

    // Once the worktree is gone, its copy is all that is left: archived there.
    git(main, 'worktree', 'remove', '--force', wt);
    const left = await projectThreads([main], env());
    expect(left[0]).toMatchObject({ live: 0 });
    await unarchiveThreads(left);
    await archiveThreads(left);
    expect((await copy!.loadHistory()).threads[0]!.archivedAt).not.toBeNull();
    // The history in JSON says where a copy comes from.
    const saved = historyJson(await projectHistory(main, { env: env() }));
    expect(saved.summary.stores.map((st) => st.origin)).toEqual(['root', 'saved']);
    expect(saved.threads[0]).toMatchObject({ savedFrom: { worktree: wt, branch: 'feat' } });

    git(main, 'worktree', 'add', '-q', wt, 'feat');
    await mkdir(join(wt, '.local-review', 'threads'), { recursive: true });
    await writeFile(inWt.threadFile(t.id), await readFile(copy!.threadFile(t.id), 'utf8'));

    // A purge deletes every journal of the thread, copies included.
    const both = await projectThreads([main], env());
    expect(both[0]!.copies).toHaveLength(2);
    expect((await purgeThreads(both)).done).toEqual([t.id]);
    expect(await projectThreads([main], env())).toEqual([]);
  });
});

describe('threads holding a draft reply of a review in progress', () => {
  it('are neither archived nor purged, so that the draft is not published out of sight or lost', async () => {
    const store = new Store(base);
    const t = await comment(base, 'Rename this');
    await store.setStatus(t.id, 'resolved', 'user');
    await backdate(store, t.id, 3);
    const review = await store.startReview();
    const draft = await store.addComment(t.id, { author: 'user', body: 'One more thing', reviewId: review.id });
    const reply = draft.comments.at(-1)!;

    const threads = await projectThreads([base], env());
    expect(threads[0]!.thread).toMatchObject({ hasDrafts: true, state: 'resolved' });
    expect(resolvedBefore(threads, new Date(at(20)))).toEqual([]);
    const plan = purgePlan(threads, new Date(at(20)));
    expect(plan.threads).toEqual([]);
    expect(plan.inProgress.map((x) => x.thread.id)).toEqual([t.id]);
    await expect(store.archiveThread(t.id)).rejects.toThrow(/draft reply in a review in progress/);
    expect((await archiveThreads(threads)).failed.map((f) => f.id)).toEqual([t.id]);

    // Once the draft is deleted (or the review discarded or submitted), the thread can go.
    await store.deleteComment(t.id, reply.id, 'user');
    const now = await projectThreads([base], env());
    expect(now[0]!.thread.hasDrafts).toBe(false);
    expect(resolvedBefore(now, new Date(at(20)))).toHaveLength(1);
    expect(purgePlan(now, new Date(at(20))).threads).toHaveLength(1);
    await store.addComment(t.id, { author: 'user', body: 'Again', reviewId: review.id });
    await store.discardReview(review.id);
    expect((await projectThreads([base], env()))[0]!.thread.hasDrafts).toBe(false);
  });
});

describe('dates given by people', () => {
  it('reads a day (local midnight), a date and time, or a number of days ago', () => {
    const now = Date.parse('2026-10-03T12:00:00Z');
    expect(parseDateArg('2026-10-01')!.getTime()).toBe(new Date(2026, 9, 1).getTime());
    expect(parseDateArg('2026-10-01T08:00:00Z')!.toISOString()).toBe('2026-10-01T08:00:00.000Z');
    expect(parseDateArg('30d', now)!.toISOString()).toBe('2026-09-03T12:00:00.000Z');
    for (const bad of ['7', '2026-02-30', 'yesterday', '2026-10-01Tnope', ''])
      expect(parseDateArg(bad, now), bad).toBeNull();
  });
});

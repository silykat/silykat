import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildAnchorContext,
  countStates,
  localReviewHome,
  looseStore,
  projectHistory,
  projectStores,
  serializeEvents,
  Store,
  threadHistory,
  type Anchor,
  type ReviewState,
  type ThreadEvent,
} from '../src/index';

const FILE = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
const anchor = (over: Partial<Anchor> = {}): Anchor => ({
  path: 'src/a.ts',
  source: 'worktree',
  ref: null,
  sha: null,
  ...buildAnchorContext(FILE, { startLine: 3, endLine: 4 }),
  ...over,
});

const at = (minute: number) => `2026-09-26T10:${String(minute).padStart(2, '0')}:00.000Z`;
const created: ThreadEvent = { v: 1, type: 'thread.created', at: at(0), by: 'user', threadId: 't_1', anchor: anchor() };
const added = (id: string, minute: number, by: 'user' | 'agent' = 'user', reviewId: string | null = null) =>
  ({
    v: 1,
    type: 'comment.added',
    at: at(minute),
    by,
    ...(by === 'agent' ? { agent: 'Claude' } : {}),
    commentId: id,
    body: `body of ${id}`,
    reviewId,
  }) as ThreadEvent;
const status = (s: 'open' | 'addressed' | 'resolved' | 'needs-info', minute: number, by: 'user' | 'agent' = 'user') =>
  ({
    v: 1,
    type: 'status.changed',
    at: at(minute),
    by,
    ...(by === 'agent' ? { agent: 'Claude' } : {}),
    status: s,
  }) as ThreadEvent;
const review = (id: string, state: ReviewState['state'], submittedAt?: string): [string, ReviewState] => [
  id,
  { id, state, branch: null, path: null, startedAt: at(0), ...(submittedAt ? { submittedAt } : {}) },
];

describe('threadHistory', () => {
  it('keeps the whole conversation in order: comments, statuses and their authors', () => {
    const h = threadHistory([created, added('c1', 0), added('c2', 2, 'agent'), status('addressed', 2, 'agent')], {
      bytes: 42,
    })!;
    expect(h.state).toBe('addressed');
    expect(h.bytes).toBe(42);
    expect(h.conversation).toEqual([
      { kind: 'comment', id: 'c1', author: 'user', body: 'body of c1', at: at(0) },
      { kind: 'comment', id: 'c2', author: 'agent', agent: 'Claude', body: 'body of c2', at: at(2) },
      { kind: 'status', status: 'addressed', by: 'agent', agent: 'Claude', at: at(2) },
    ]);
    expect(h.lastActivityAt).toBe(at(2));
  });

  it('keeps a deleted thread with what was said, and when it was deleted', () => {
    const h = threadHistory([
      created,
      added('c1', 0),
      status('resolved', 3),
      { v: 1, type: 'thread.deleted', at: at(5), by: 'user' },
      { v: 1, type: 'thread.deleted', at: at(6), by: 'user' },
    ])!;
    expect(h.state).toBe('deleted');
    expect(h.status).toBe('resolved');
    expect(h.deletedAt).toBe(at(5));
    expect(h.conversation.at(-1)).toEqual({ kind: 'deleted', by: 'user', at: at(5) });
    expect(h.conversation.filter((e) => e.kind === 'deleted')).toHaveLength(1);
    expect(h.lastActivityAt).toBe(at(5));
  });

  it('keeps comments deleted by their author, with their last text', () => {
    const h = threadHistory([
      created,
      added('c1', 0),
      { v: 1, type: 'comment.edited', at: at(1), by: 'user', commentId: 'c1', body: 'edited text' },
      { v: 1, type: 'comment.edited', at: at(1), by: 'agent', agent: 'Claude', commentId: 'c1', body: 'not theirs' },
      { v: 1, type: 'comment.deleted', at: at(4), by: 'user', commentId: 'c1' },
      { v: 1, type: 'comment.edited', at: at(7), by: 'user', commentId: 'c1', body: 'after deletion' },
      { v: 1, type: 'comment.deleted', at: at(8), by: 'agent', agent: 'Claude', commentId: 'c1' },
    ])!;
    expect(h.conversation[0]).toMatchObject({ body: 'edited text', editedAt: at(1), deletedAt: at(4) });
    // Its only comment deleted: the thread is gone, even without the event (older journals).
    expect(h.state).toBe('deleted');
    expect(h.deletedAt).toBe(at(4));
  });

  it('leaves out drafts: in progress, discarded, and threads that only hold drafts', () => {
    const reviews = new Map([review('r_live', 'active'), review('r_gone', 'discarded')]);
    expect(threadHistory([created, added('c1', 0, 'user', 'r_live')], { reviews })).toBeNull();
    expect(threadHistory([created, added('c1', 0, 'user', 'r_gone')], { reviews })).toBeNull();
    const h = threadHistory([created, added('c1', 0), added('c2', 1, 'user', 'r_live')], { reviews })!;
    expect(h.conversation.map((e) => e.kind === 'comment' && e.id)).toEqual(['c1']);
  });

  it('dates a comment of a submitted review by its submission, too', () => {
    const reviews = new Map([review('r_1', 'submitted', at(30))]);
    const h = threadHistory([created, added('c1', 0, 'user', 'r_1')], { reviews })!;
    expect(h.conversation[0]).toMatchObject({ at: at(0), publishedAt: at(30) });
    expect(h.lastActivityAt).toBe(at(30));
  });

  it('leaves out the drafts of a review submitted after the thread was deleted', () => {
    const reviews = new Map([review('r_1', 'submitted', at(30))]);
    const deleted: ThreadEvent = { v: 1, type: 'thread.deleted', at: at(10), by: 'user' };
    const h = threadHistory([created, added('c1', 0), added('c2', 5, 'user', 'r_1'), deleted], { reviews })!;
    expect(h.conversation.map((e) => (e.kind === 'comment' ? e.id : e.kind))).toEqual(['c1', 'deleted']);
    expect(threadHistory([created, added('c1', 0, 'user', 'r_1'), deleted], { reviews })).toBeNull();
  });

  it('follows the anchor and the branch, and marks journals of a newer version', () => {
    const moved = anchor({ path: 'src/b.ts' });
    const branch = { repo: '/r/.git', branch: 'feat' };
    const h = threadHistory(
      [
        created,
        added('c1', 0),
        { v: 1, type: 'anchor.updated', at: at(50), by: 'user', anchor: moved },
        { v: 1, type: 'branch.changed', at: at(51), by: 'user', branch },
        { ...created, at: at(52) },
      ],
      { futureVersion: true },
    )!;
    expect(h.anchor.path).toBe('src/b.ts');
    expect(h.branch).toEqual(branch);
    expect(h.readOnly).toBe(true);
    // Moving the code is not activity.
    expect(h.lastActivityAt).toBe(at(0));
  });

  it('needs a creation event', () => {
    expect(threadHistory([added('c1', 0)])).toBeNull();
    expect(threadHistory([])).toBeNull();
  });

  it('counts threads per state', () => {
    const open = threadHistory([created, added('c1', 0)])!;
    const gone = threadHistory([created, added('c1', 0), { v: 1, type: 'thread.deleted', at: at(1), by: 'user' }])!;
    expect(countStates([open, open, gone])).toEqual({
      open: 2,
      'needs-info': 0,
      addressed: 0,
      resolved: 0,
      deleted: 1,
    });
  });
});

let base: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd, stdio: 'pipe' });
const env = () => ({ LOCAL_REVIEW_HOME: join(base, 'home') });
const comment = (root: string, body: string) =>
  new Store(root).createThread(anchor(), { author: 'user', body, reviewId: null });

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'lr-history-')));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('Store.loadHistory', () => {
  it('reads every thread, deleted ones included, with the size of its journal', async () => {
    const store = new Store(base);
    const kept = await comment(base, 'keep');
    const gone = await comment(base, 'remove');
    await store.deleteThread(gone.id, 'user');
    await writeFile(join(store.threadsDir, 't_01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl'), '{"v":1,"type":"comment.added"}\n');
    const { threads, warnings } = await store.loadHistory();
    expect(threads.map((t) => [t.id, t.state]).sort()).toEqual(
      [
        [kept.id, 'open'],
        [gone.id, 'deleted'],
      ].sort(),
    );
    expect(threads.every((t) => t.bytes > 100)).toBe(true);
    expect(warnings).toEqual(['threads/t_01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl: no thread.created event, file skipped']);
  });

  it('never shows what was deleted or edited while it was still a draft of a submitted review', async () => {
    const store = new Store(base);
    const kept = await comment(base, 'published');
    const review = await store.startReview();
    const draft = (body: string) => ({ author: 'user' as const, body, reviewId: review.id });
    // A whole thread written and deleted as a draft, by its only comment or with "Delete Thread".
    const gone = await store.createThread(anchor(), draft('secret draft'));
    await store.deleteComment(gone.id, gone.comments[0]!.id, 'user');
    const dropped = await store.createThread(anchor(), draft('dropped draft'));
    await store.deleteThread(dropped.id, 'user');
    // A draft reply deleted, another one rewritten, before submitting.
    const withReply = await store.addComment(kept.id, draft('draft reply'));
    await store.deleteComment(kept.id, withReply.comments[1]!.id, 'user');
    const rewritten = await store.addComment(kept.id, draft('first wording'));
    await new Promise((r) => setTimeout(r, 5));
    await store.editComment(kept.id, rewritten.comments[1]!.id, 'final wording', 'user');
    await new Promise((r) => setTimeout(r, 5));
    await store.submitReview(review.id);

    const { threads } = await store.loadHistory();
    expect(threads.map((t) => t.id)).toEqual([kept.id]);
    const comments = threads[0]!.conversation.filter((e) => e.kind === 'comment');
    expect(comments.map((c) => [c.body, c.editedAt, c.deletedAt])).toEqual([
      ['published', undefined, undefined],
      ['final wording', undefined, undefined],
    ]);
  });

  it('is empty, without creating anything, where nothing was commented', async () => {
    expect(await new Store(join(base, 'none')).loadHistory()).toEqual({ threads: [], warnings: [] });
  });
});

describe('projectStores', () => {
  it('finds the stores of the folder and below, skipping dependencies, builds and hidden folders', async () => {
    for (const dir of ['.', 'a', 'b/c', 'node_modules/x', 'dist', '.hidden/y'])
      await comment(join(base, 'p', dir), dir);
    const stores = await projectStores(join(base, 'p'), env());
    expect(stores).toEqual([
      { root: join(base, 'p'), origin: 'root' },
      { root: join(base, 'p', 'a'), origin: 'below' },
      { root: join(base, 'p', 'b', 'c'), origin: 'below' },
    ]);
  });

  it('never takes the machine folder for a store', async () => {
    await comment(base, 'base');
    const home = { LOCAL_REVIEW_HOME: join(base, '.local-review') };
    await looseStore(home).createThread(anchor({ path: '/x/a.ts' }), { author: 'user', body: 'x', reviewId: null });
    expect(localReviewHome(home)).toBe(join(base, '.local-review'));
    expect(await projectStores(base, home)).toEqual([]);
  });

  it('takes the closest store above when the folder has none', async () => {
    await comment(base, 'top');
    await mkdir(join(base, 'src', 'deep'), { recursive: true });
    expect(await projectStores(join(base, 'src', 'deep'), env())).toEqual([{ root: base, origin: 'above' }]);
  });

  it('finds the worktrees of the repositories of the project, even outside it, once each', async () => {
    const parent = join(base, 'work');
    const repo = join(parent, 'api');
    await mkdir(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    await writeFile(join(repo, 'a.ts'), FILE);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    git(repo, 'worktree', 'add', '-q', '-b', 'inside', join(parent, 'api-inside'));
    git(repo, 'worktree', 'add', '-q', '-b', 'beside', join(base, 'api-beside'));
    git(repo, 'worktree', 'add', '-q', '-b', 'hidden', join(repo, '.claude', 'worktrees', 'h'));
    for (const dir of [repo, join(parent, 'api-inside'), join(base, 'api-beside'), join(repo, '.claude/worktrees/h')])
      await comment(dir, dir);

    expect(await projectStores(parent, env())).toEqual([
      { root: repo, origin: 'below' },
      { root: join(parent, 'api-inside'), origin: 'below' },
      { root: join(base, 'api-beside'), origin: 'worktree' },
      { root: join(repo, '.claude', 'worktrees', 'h'), origin: 'worktree' },
    ]);
    // From a worktree: the main repository and the other worktrees.
    expect((await projectStores(join(base, 'api-beside'), env())).map((s) => s.origin)).toEqual([
      'root',
      'worktree',
      'worktree',
      'worktree',
    ]);
    // A worktree removed by hand, and a folder outside git: nothing more, no error.
    await rm(join(base, 'api-beside'), { recursive: true, force: true });
    expect(await projectStores(parent, env())).toHaveLength(3);
    expect(await projectStores(join(base, 'nowhere'), env())).toEqual([]);
  });

  it('is the machine store alone for the files outside any open folder', async () => {
    expect(await projectStores('/', env())).toEqual([{ root: '/', origin: 'root' }]);
  });
});

describe('projectHistory', () => {
  it('gathers the threads of every store, counted per state, store and size', async () => {
    const a = await comment(join(base, 'p', 'a'), 'one');
    await comment(join(base, 'p', 'b'), 'two');
    await new Store(join(base, 'p', 'a')).setStatus(a.id, 'resolved', 'user');
    const h = await projectHistory(join(base, 'p'), { env: env() });
    expect(h.root).toBe(join(base, 'p'));
    expect(h.since).toBeNull();
    expect(h.threads).toBe(2);
    expect(h.states).toMatchObject({ open: 1, resolved: 1 });
    expect(h.stores.map((s) => [s.origin, s.threads.length, s.states.resolved])).toEqual([
      ['below', 1, 1],
      ['below', 1, 0],
    ]);
    expect(h.bytes).toBe(h.stores[0]!.bytes + h.stores[1]!.bytes);
    expect(h.bytes).toBeGreaterThan(0);
  });

  it('keeps the threads active since a date, oldest first', async () => {
    const store = new Store(base);
    const write = async (id: string, minute: number, extra: ThreadEvent[] = []) => {
      await mkdir(store.threadsDir, { recursive: true });
      const events = [{ ...created, threadId: id, at: at(minute) }, added(`c${id}`, minute), ...extra];
      await writeFile(join(store.threadsDir, `${id}.jsonl`), serializeEvents(events));
    };
    await write('t_01ARZ3NDEKTSV4RRFFQ69G5FA1', 10);
    await write('t_01ARZ3NDEKTSV4RRFFQ69G5FA2', 1, [status('resolved', 40)]);
    await write('t_01ARZ3NDEKTSV4RRFFQ69G5FA3', 5);
    const h = await projectHistory(base, { since: new Date(at(10)), env: env() });
    expect(h.since).toBe(at(10));
    expect(h.stores[0]!.threads.map((t) => t.id)).toEqual([
      't_01ARZ3NDEKTSV4RRFFQ69G5FA2',
      't_01ARZ3NDEKTSV4RRFFQ69G5FA1',
    ]);
    expect((await projectHistory(base, { env: env() })).threads).toBe(3);
  });
});

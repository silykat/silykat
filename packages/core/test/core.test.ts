import { mkdtemp, readFile, rm, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildAnchorContext,
  foldThread,
  agentView,
  findStoreRoot,
  findStoresBelow,
  parseJournal,
  reanchor,
  serializeEvents,
  Store,
  ulid,
  newThreadId,
  type Anchor,
  type ReviewState,
  type ThreadEvent,
  type ThreadState,
} from '../src/index';

const FILE = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

function anchor(overrides: Partial<Anchor> = {}): Anchor {
  return {
    path: 'src/a.ts',
    source: 'worktree',
    ref: null,
    sha: null,
    ...buildAnchorContext(FILE, { startLine: 10, endLine: 12 }),
    ...overrides,
  };
}

const created = (a = anchor()): ThreadEvent => ({
  v: 1,
  type: 'thread.created',
  at: '2026-09-26T10:00:00.000Z',
  by: 'user',
  threadId: 't_1',
  anchor: a,
});
const added = (id: string, by: 'user' | 'agent', body: string, reviewId: string | null = null): ThreadEvent => ({
  v: 1,
  type: 'comment.added',
  at: '2026-09-26T10:01:00.000Z',
  by,
  commentId: id,
  body,
  reviewId,
});

describe('ids', () => {
  it('produces prefixed, unique, time-sortable ids', () => {
    expect(newThreadId()).toMatch(/^t_[0-9A-HJKMNP-TV-Z]{26}$/);
    const ids = new Set(Array.from({ length: 1000 }, () => ulid()));
    expect(ids.size).toBe(1000);
    expect(ulid(1000) < ulid(2000)).toBe(true);
  });
});

describe('buildAnchorContext', () => {
  it('captures snippet and surrounding context', () => {
    const ctx = buildAnchorContext(FILE, { startLine: 10, endLine: 12 });
    expect(ctx.snippet).toBe('line 10\nline 11\nline 12');
    expect(ctx.contextBefore).toEqual(['line 7', 'line 8', 'line 9']);
    expect(ctx.contextAfter).toEqual(['line 13', 'line 14', 'line 15']);
  });

  it('handles file boundaries and CRLF', () => {
    const ctx = buildAnchorContext('a\r\nb\r\nc', { startLine: 1, endLine: 1 });
    expect(ctx.snippet).toBe('a');
    expect(ctx.contextBefore).toEqual([]);
    expect(ctx.contextAfter).toEqual(['b', 'c']);
  });

  it('clamps out-of-range lines', () => {
    const ctx = buildAnchorContext('a\nb', { startLine: 2, endLine: 9 });
    expect(ctx.range).toEqual({ startLine: 2, endLine: 2 });
    expect(ctx.snippet).toBe('b');
  });
});

describe('parseJournal', () => {
  it('round-trips serialized events', () => {
    const events = [created(), added('c_1', 'user', 'hi')];
    expect(parseJournal(serializeEvents(events)).events).toEqual(events);
  });

  it('skips corrupt lines with a warning and keeps the rest', () => {
    const text = serializeEvents([created()]) + '{not json\n' + serializeEvents([added('c_1', 'user', 'hi')]);
    const parsed = parseJournal(text, 'x.jsonl');
    expect(parsed.events).toHaveLength(2);
    expect(parsed.warnings).toEqual(['x.jsonl:2: invalid JSON, line skipped']);
  });

  it('ignores an interrupted trailing line silently', () => {
    const text = serializeEvents([created()]) + '{"v":1,"type":"comm';
    const parsed = parseJournal(text);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.warnings).toEqual([]);
  });

  it('flags events from a future schema version', () => {
    const text = serializeEvents([created()]) + JSON.stringify({ v: 99, type: 'whatever' }) + '\n';
    const parsed = parseJournal(text);
    expect(parsed.futureVersion).toBe(true);
    expect(parsed.events).toHaveLength(1);
  });

  it('skips unknown event types of the current version', () => {
    const parsed = parseJournal(JSON.stringify({ v: 1, type: 'nope', at: '', by: 'user' }) + '\n');
    expect(parsed.events).toEqual([]);
    expect(parsed.warnings[0]).toContain('unknown event type');
  });
});

describe('foldThread', () => {
  it('returns null without thread.created', () => {
    expect(foldThread([added('c_1', 'user', 'x')])).toBeNull();
  });

  it('builds a direct comment thread', () => {
    const s = foldThread([created(), added('c_1', 'user', 'hi')])!;
    expect(s).toMatchObject({ id: 't_1', status: 'open', lastAuthor: 'user', hasPublished: true, onlyDrafts: false });
    expect(s.comments).toEqual([
      { id: 'c_1', author: 'user', body: 'hi', createdAt: '2026-09-26T10:01:00.000Z', reviewId: null, isDraft: false },
    ]);
  });

  it('applies edits, deletions, status, anchor updates and deletion', () => {
    const moved = anchor({ range: { startLine: 15, endLine: 17 } });
    const s = foldThread([
      created(),
      added('c_1', 'user', 'hi'),
      added('c_2', 'agent', 'why?'),
      { v: 1, type: 'comment.edited', at: 't', by: 'user', commentId: 'c_1', body: 'hello' },
      { v: 1, type: 'status.changed', at: 't', by: 'agent', status: 'needs-info' },
      { v: 1, type: 'anchor.updated', at: 't', by: 'user', anchor: moved },
    ])!;
    expect(s.comments.map((c) => c.body)).toEqual(['hello', 'why?']);
    expect(s.comments[0]!.editedAt).toBe('t');
    expect(s.status).toBe('needs-info');
    expect(s.lastAuthor).toBe('agent');
    expect(s.anchor.range).toEqual({ startLine: 15, endLine: 17 });

    const d = foldThread([
      created(),
      added('c_1', 'user', 'hi'),
      { v: 1, type: 'thread.deleted', at: 't', by: 'user' },
    ])!;
    expect(d.deleted).toBe(true);
  });

  it('refuses edits and deletions by another author', () => {
    const s = foldThread([
      created(),
      added('c_1', 'user', 'hi'),
      { v: 1, type: 'comment.edited', at: 't', by: 'agent', commentId: 'c_1', body: 'hacked' },
      { v: 1, type: 'comment.deleted', at: 't', by: 'agent', commentId: 'c_1' },
    ])!;
    expect(s.comments.map((c) => c.body)).toEqual(['hi']);
  });

  it('computes drafts from review states', () => {
    const reviews = new Map<string, ReviewState>([
      ['r_active', { id: 'r_active', state: 'active', branch: null, path: null, startedAt: 't' }],
      ['r_done', { id: 'r_done', state: 'submitted', branch: null, path: null, startedAt: 't' }],
      ['r_gone', { id: 'r_gone', state: 'discarded', branch: null, path: null, startedAt: 't' }],
    ]);
    const draftOnly = foldThread([created(), added('c_1', 'user', 'x', 'r_active')], { reviews })!;
    expect(draftOnly).toMatchObject({ onlyDrafts: true, hasPublished: false });
    expect(draftOnly.comments[0]!.isDraft).toBe(true);

    const submitted = foldThread([created(), added('c_1', 'user', 'x', 'r_done')], { reviews })!;
    expect(submitted.comments[0]!.isDraft).toBe(false);

    const discarded = foldThread([created(), added('c_1', 'user', 'x', 'r_gone')], { reviews })!;
    expect(discarded.comments).toEqual([]);
  });

  it('marks threads from a future version read-only', () => {
    expect(foldThread([created()], { futureVersion: true })!.readOnly).toBe(true);
  });
});

describe('Store', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lr-core-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('treats a missing store as empty and does not create it', async () => {
    const store = new Store(root);
    expect(await store.loadAll()).toEqual({ threads: [], reviews: [], warnings: [] });
    expect(await readdir(root)).toEqual([]);
  });

  it('creates a thread as one journal with two events, plus schema-version', async () => {
    const store = new Store(root);
    const state = await store.createThread(anchor(), { author: 'user', body: '  Hello **world**  ', reviewId: null });

    const lines = (await readFile(store.threadFile(state.id), 'utf8'))
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(['thread.created', 'comment.added']);
    expect(lines[0].anchor.range).toEqual({ startLine: 10, endLine: 12 });
    expect(lines[1]).toMatchObject({ by: 'user', body: 'Hello **world**', reviewId: null });
    expect(await readFile(join(root, '.local-review', 'schema-version'), 'utf8')).toBe('1\n');
  });

  it('reloads what it wrote', async () => {
    const store = new Store(root);
    const a = await store.createThread(anchor(), { author: 'user', body: 'one', reviewId: null });
    const b = await store.createThread(anchor({ path: 'b.ts' }), { author: 'user', body: 'two', reviewId: null });
    const { threads, warnings } = await new Store(root).loadAll();
    expect(warnings).toEqual([]);
    expect(threads.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
    expect(threads.find((t) => t.id === a.id)!.comments[0]!.body).toBe('one');
  });

  it('rejects an empty body', async () => {
    await expect(
      new Store(root).createThread(anchor(), { author: 'user', body: '   ', reviewId: null }),
    ).rejects.toThrow(/empty/);
  });

  it('skips unreadable threads with warnings but loads the others', async () => {
    const store = new Store(root);
    const ok = await store.createThread(anchor(), { author: 'user', body: 'ok', reviewId: null });
    await mkdir(store.threadsDir, { recursive: true });
    await writeFile(join(store.threadsDir, 't_broken.jsonl'), 'garbage\n');
    const { threads, warnings } = await store.loadAll();
    expect(threads.map((t) => t.id)).toEqual([ok.id]);
    expect(warnings).toHaveLength(2); // invalid line + no thread.created
  });
});

describe('Store — replies and statuses', () => {
  let root: string;
  let store: Store;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lr-core-'));
    store = new Store(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const newThread = () => store.createThread(anchor(), { author: 'user', body: 'Why null here?', reviewId: null });

  it('adds an agent reply and its status in a single write', async () => {
    const t = await newThread();
    const s = await store.addComment(
      t.id,
      { author: 'agent', agent: 'Claude', body: 'Which error?', reviewId: null },
      { status: 'needs-info' },
    );
    expect(s.comments.map((c) => [c.author, c.body])).toEqual([
      ['user', 'Why null here?'],
      ['agent', 'Which error?'],
    ]);
    expect(s.status).toBe('needs-info');
    expect(s.lastAuthor).toBe('agent');

    const lines = (await readFile(store.threadFile(t.id), 'utf8')).trimEnd().split('\n');
    expect(lines.map((l) => JSON.parse(l).type)).toEqual([
      'thread.created',
      'comment.added',
      'comment.added',
      'status.changed',
    ]);
  });

  it('records the agent name on its comments and events', async () => {
    const t = await newThread();
    const s = await store.addComment(
      t.id,
      { author: 'agent', agent: 'Codex', body: 'Why?', reviewId: null },
      { status: 'needs-info' },
    );
    expect(s.comments[1]).toMatchObject({ author: 'agent', agentName: 'Codex' });
    expect(s.comments[0]!.agentName).toBeUndefined();
    expect(s.lastAgentName).toBe('Codex');
    const events = (await readFile(store.threadFile(t.id), 'utf8'))
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(events.slice(2).map((e) => [e.by, e.agent])).toEqual([
      ['agent', 'Codex'],
      ['agent', 'Codex'],
    ]);
  });

  it('requires agents to give their name', async () => {
    const t = await newThread();
    await expect(store.addComment(t.id, { author: 'agent', body: 'x', reviewId: null })).rejects.toThrow(/name/);
    await expect(store.addComment(t.id, { author: 'agent', agent: '  ', body: 'x', reviewId: null })).rejects.toThrow(
      /name/,
    );
    await expect(store.setStatus(t.id, 'addressed', 'agent')).rejects.toThrow(/name/);
  });

  it('reads pre-release journals written with by: "claude" as the agent Claude', async () => {
    const t = await newThread();
    await writeFile(
      store.threadFile(t.id),
      JSON.stringify({
        v: 1,
        type: 'comment.added',
        at: 't',
        by: 'claude',
        commentId: 'c_x',
        body: 'old',
        reviewId: null,
      }) + '\n',
      { flag: 'a' },
    );
    const s = (await store.loadThread(t.id)).state!;
    expect(s.comments[1]).toMatchObject({ author: 'agent', agentName: 'Claude', body: 'old' });
  });

  it('adds a reply without changing the status', async () => {
    const t = await newThread();
    const s = await store.addComment(t.id, { author: 'agent', agent: 'Claude', body: 'Noted.', reviewId: null });
    expect(s.status).toBe('open');
  });

  it('sets a status on its own', async () => {
    const t = await newThread();
    expect((await store.setStatus(t.id, 'addressed', 'agent', 'Claude')).status).toBe('addressed');
    expect((await store.loadThread(t.id)).state!.status).toBe('addressed');
  });

  it('never lets an agent resolve a thread', async () => {
    const t = await newThread();
    await expect(store.setStatus(t.id, 'resolved', 'agent')).rejects.toThrow(/Only the user/);
    await expect(
      store.addComment(
        t.id,
        { author: 'agent', agent: 'Claude', body: 'done', reviewId: null },
        { status: 'resolved' },
      ),
    ).rejects.toThrow(/Only the user/);
    expect((await store.loadThread(t.id)).state!.comments).toHaveLength(1);
  });

  it('refuses to write to unknown, deleted or read-only threads', async () => {
    await expect(
      store.addComment('t_00000000000000000000000000', { author: 'agent', agent: 'Claude', body: 'x', reviewId: null }),
    ).rejects.toThrow(/not found/);

    const t = await newThread();
    await writeFile(store.threadFile(t.id), JSON.stringify({ v: 99, type: 'future' }) + '\n', { flag: 'a' });
    await expect(
      store.addComment(t.id, { author: 'agent', agent: 'Claude', body: 'x', reviewId: null }),
    ).rejects.toThrow(/read-only/);
  });

  it('rejects ids that could escape the store', async () => {
    await expect(store.loadThread('../../etc/passwd')).rejects.toThrow(/Invalid thread id/);
    expect(Store.threadIdOf('t_01J8XK0000000000000000000A.jsonl')).toBe('t_01J8XK0000000000000000000A');
    expect(Store.threadIdOf('notes.txt')).toBeNull();
  });

  it('loadThread returns null for a missing thread', async () => {
    expect(await store.loadThread('t_00000000000000000000000000')).toEqual({ state: null, warnings: [] });
  });
});

describe('Store — user replies', () => {
  let root: string;
  let store: Store;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lr-core-'));
    store = new Store(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const events = async (id: string) =>
    (await readFile(store.threadFile(id), 'utf8'))
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l));
  const reply = (id: string, body: string) => store.addComment(id, { author: 'user', body, reviewId: null });

  for (const from of ['needs-info', 'addressed'] as const) {
    it(`hands a ${from} thread back to the agent`, async () => {
      const t = await store.createThread(anchor(), { author: 'user', body: 'q', reviewId: null });
      await store.addComment(t.id, { author: 'agent', agent: 'Claude', body: 'a', reviewId: null }, { status: from });
      const s = await reply(t.id, 'here is the detail');
      expect(s.status).toBe('open');
      expect(s.lastAuthor).toBe('user');
      expect((await events(t.id)).slice(-2).map((e) => [e.type, e.by, e.status])).toEqual([
        ['comment.added', 'user', undefined],
        ['status.changed', 'user', 'open'],
      ]);
    });
  }

  it('reopens a resolved thread', async () => {
    const t = await store.createThread(anchor(), { author: 'user', body: 'q', reviewId: null });
    await store.setStatus(t.id, 'resolved', 'user');
    expect((await reply(t.id, 'one more thing')).status).toBe('open');
  });

  it('writes no status event when the thread is already open', async () => {
    const t = await store.createThread(anchor(), { author: 'user', body: 'q', reviewId: null });
    await reply(t.id, 'precision');
    expect((await events(t.id)).map((e) => e.type)).toEqual(['thread.created', 'comment.added', 'comment.added']);
  });

  it('does not reopen for a draft reply (it is published later, with the review)', async () => {
    const t = await store.createThread(anchor(), { author: 'user', body: 'q', reviewId: null });
    await store.setStatus(t.id, 'addressed', 'agent', 'Claude');
    const review = await store.startReview();
    const s = await store.addComment(t.id, { author: 'user', body: 'draft', reviewId: review.id });
    expect(s.status).toBe('addressed');
  });

  it('loses nothing when the user and the agent write at the same time', async () => {
    const t = await store.createThread(anchor(), { author: 'user', body: 'q', reviewId: null });
    const user = new Store(root);
    const agent = new Store(root);
    const N = 200;
    await Promise.all(
      Array.from({ length: N }, (_, i) => [
        user.addComment(t.id, { author: 'user', body: `user ${i}`, reviewId: null }),
        agent.addComment(t.id, { author: 'agent', agent: 'Claude', body: `agent ${i}`, reviewId: null }),
      ]).flat(),
    );
    const s = (await store.loadThread(t.id)).state!;
    expect(s.comments).toHaveLength(1 + 2 * N);
    const bodies = new Set(s.comments.map((c) => c.body));
    for (let i = 0; i < N; i++) {
      expect(bodies.has(`user ${i}`)).toBe(true);
      expect(bodies.has(`agent ${i}`)).toBe(true);
    }
    const parsed = parseJournal(await readFile(store.threadFile(t.id), 'utf8'));
    expect(parsed.warnings).toEqual([]); // no interleaved or torn lines
  });
});

describe('Store — edit and delete', () => {
  let root: string;
  let store: Store;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lr-core-'));
    store = new Store(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const withAgentReply = async () => {
    const t = await store.createThread(anchor(), { author: 'user', body: 'first', reviewId: null });
    return store.addComment(t.id, { author: 'agent', agent: 'Claude', body: 'answer', reviewId: null });
  };

  it('edits the user own comment and marks it edited', async () => {
    const t = await withAgentReply();
    const s = await store.editComment(t.id, t.comments[0]!.id, '  first, reworded  ', 'user');
    expect(s.comments[0]).toMatchObject({ body: 'first, reworded' });
    expect(s.comments[0]!.editedAt).toBeDefined();
    expect(s.comments[1]!.editedAt).toBeUndefined();
  });

  it('writes nothing when the text did not change', async () => {
    const t = await withAgentReply();
    const before = await readFile(store.threadFile(t.id), 'utf8');
    await store.editComment(t.id, t.comments[0]!.id, 'first', 'user');
    expect(await readFile(store.threadFile(t.id), 'utf8')).toBe(before);
  });

  it('refuses to edit or delete someone else’s comment, or an empty edit', async () => {
    const t = await withAgentReply();
    const agentComment = t.comments[1]!.id;
    await expect(store.editComment(t.id, agentComment, 'mine now', 'user')).rejects.toThrow(/own comments/);
    await expect(store.deleteComment(t.id, agentComment, 'user')).rejects.toThrow(/own comments/);
    await expect(store.editComment(t.id, t.comments[0]!.id, '  ', 'user')).rejects.toThrow(/empty/);
    await expect(store.deleteComment(t.id, 'c_missing', 'user')).rejects.toThrow(/not found/);
  });

  it('deletes a comment and keeps the thread', async () => {
    const t = await withAgentReply();
    const extra = await store.addComment(t.id, { author: 'user', body: 'typo', reviewId: null });
    const s = await store.deleteComment(t.id, extra.comments[2]!.id, 'user');
    expect(s.deleted).toBe(false);
    expect(s.comments.map((c) => c.body)).toEqual(['first', 'answer']);
  });

  it('deletes the thread with its last comment', async () => {
    const t = await store.createThread(anchor(), { author: 'user', body: 'alone', reviewId: null });
    const s = await store.deleteComment(t.id, t.comments[0]!.id, 'user');
    expect(s.deleted).toBe(true);
    expect((await store.loadAll()).threads).toEqual([]);
  });

  it('deletes a whole thread, agent replies included, and keeps its journal', async () => {
    const t = await withAgentReply();
    const s = await store.deleteThread(t.id, 'user');
    expect(s.deleted).toBe(true);
    expect((await store.loadAll()).threads).toEqual([]);
    const types = (await readFile(store.threadFile(t.id), 'utf8'))
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l).type);
    expect(types).toEqual(['thread.created', 'comment.added', 'comment.added', 'thread.deleted']);
  });

  it('only lets the user delete a thread, and never writes to a deleted one', async () => {
    const t = await withAgentReply();
    await expect(store.deleteThread(t.id, 'agent')).rejects.toThrow(/Only the user/);
    await store.deleteThread(t.id, 'user');
    await expect(
      store.addComment(t.id, { author: 'agent', agent: 'Claude', body: 'late', reviewId: null }),
    ).rejects.toThrow(/not found/);
  });
});

describe('reanchor', () => {
  const file = (lines: string[]) => lines.join('\n') + '\n';
  const BASE = ['import x', '', 'function a() {', '  return null;', '}', '', 'function b() {', '  return 1;', '}'];
  const at = (startLine: number, endLine: number, text = file(BASE)) => ({
    path: 'a.ts',
    source: 'worktree' as const,
    ref: null,
    sha: null,
    ...buildAnchorContext(text, { startLine, endLine }),
  });

  it('keeps an anchor whose code did not move', () => {
    expect(reanchor(at(3, 5), file(BASE))).toEqual({ kind: 'exact', range: { startLine: 3, endLine: 5 } });
  });

  it('follows code moved by lines inserted above', () => {
    const moved = file(['// header', '// more', ...BASE]);
    expect(reanchor(at(3, 5), moved)).toEqual({ kind: 'moved', range: { startLine: 5, endLine: 7 } });
  });

  it('picks the closest occurrence, then the best context', () => {
    // "}" appears twice; the anchor is on the first one (line 5)
    expect(reanchor(at(5, 5), file(['x', ...BASE]))).toEqual({ kind: 'moved', range: { startLine: 6, endLine: 6 } });
    // two identical lines at the same distance from the stored position: the surrounding lines decide
    const dup = ['a', 'SAME', 'c', 'SAME', 'e'];
    const onFirst = { ...at(2, 2, file(dup)), range: { startLine: 3, endLine: 3 } }; // context of line 2, stored on line 3
    expect(reanchor(onFirst, file(dup))).toEqual({ kind: 'moved', range: { startLine: 2, endLine: 2 } });
    const onSecond = { ...at(4, 4, file(dup)), range: { startLine: 3, endLine: 3 } }; // context of line 4
    expect(reanchor(onSecond, file(dup))).toEqual({ kind: 'moved', range: { startLine: 4, endLine: 4 } });
  });

  it('reports lost code', () => {
    expect(reanchor(at(3, 5), file(['completely', 'different']))).toEqual({ kind: 'lost' });
  });

  it('ignores file-level anchors', () => {
    expect(reanchor({ ...at(1, 1), range: null }, file(BASE))).toBeNull();
  });
});

describe('Store.updateAnchor', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lr-core-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('records the new position', async () => {
    const store = new Store(root);
    const t = await store.createThread(anchor(), { author: 'user', body: 'x', reviewId: null });
    const moved = { ...t.anchor, ...buildAnchorContext(FILE, { startLine: 15, endLine: 17 }) };
    const s = await store.updateAnchor(t.id, moved, 'user');
    expect(s.anchor.range).toEqual({ startLine: 15, endLine: 17 });
    expect(s.anchor.snippet).toBe('line 15\nline 16\nline 17');
    expect((await store.loadThread(t.id)).state!.anchor.range).toEqual({ startLine: 15, endLine: 17 });
  });
});

describe('reanchor — whitespace changes', () => {
  const file = (lines: string[]) => lines.join('\n') + '\n';
  const BASE = ['function a() {', '  if (x) {', '    return null;', '  }', '}'];
  const at = (startLine: number, endLine: number) => ({
    path: 'a.ts',
    source: 'worktree' as const,
    ref: null,
    sha: null,
    ...buildAnchorContext(file(BASE), { startLine, endLine }),
  });

  it('tolerates re-indentation and spacing changes', () => {
    const reformatted = ['function a() {', '    if (x){', '        return   null;', '    }', '}'];
    expect(reanchor(at(2, 4), file(reformatted))).toEqual({ kind: 'fuzzy', range: { startLine: 2, endLine: 4 } });
    expect(reanchor(at(2, 4), file(['// moved', ...reformatted]))).toEqual({
      kind: 'fuzzy',
      range: { startLine: 3, endLine: 5 },
    });
  });

  it('still prefers an exact match over a whitespace-only one', () => {
    const both = ['if (x) {', 'return null;', '}', '', ...BASE]; // loose copy first (closer), exact copy later
    expect(reanchor(at(2, 4), file(both))).toEqual({ kind: 'moved', range: { startLine: 6, endLine: 8 } });
  });

  it('reports real code changes as lost', () => {
    expect(reanchor(at(2, 4), file(['function a() {', '  if (y) {', '    return 0;', '  }', '}']))).toEqual({
      kind: 'lost',
    });
  });

  it('never matches a blank-only snippet loosely', () => {
    const blank = { ...at(1, 1), snippet: '   ', range: { startLine: 1, endLine: 1 } };
    expect(reanchor(blank, file(BASE))).toEqual({ kind: 'lost' });
  });
});

describe('Store — review mode', () => {
  let root: string;
  let store: Store;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lr-core-'));
    store = new Store(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('starts one review at a time', async () => {
    expect(await store.activeReview()).toBeNull();
    const r = await store.startReview();
    expect(r).toMatchObject({ state: 'active' });
    expect(r.id).toMatch(/^r_/);
    expect(await store.startReview()).toEqual(r);
    expect(await store.activeReview()).toEqual(r);
  });

  it('keeps draft comments as drafts until the review is submitted', async () => {
    const r = await store.startReview();
    const t = await store.createThread(anchor(), { author: 'user', body: 'draft one', reviewId: r.id });
    expect(t).toMatchObject({ onlyDrafts: true, hasPublished: false });
    expect(t.comments[0]!.isDraft).toBe(true);

    const reloaded = await new Store(root).loadAll();
    expect(reloaded.threads[0]!.comments[0]!.isDraft).toBe(true);
    expect(reloaded.reviews.map((x) => x.state)).toEqual(['active']);

    const submitted = await store.submitReview(r.id, '  Overall: looks good  ');
    expect(submitted).toMatchObject({ state: 'submitted', summary: 'Overall: looks good' });
    expect(submitted.submittedAt).toBeDefined();
    const after = (await store.loadThread(t.id)).state!;
    expect(after).toMatchObject({ onlyDrafts: false, hasPublished: true });
    expect(after.comments[0]!.isDraft).toBe(false);
    expect(await store.activeReview()).toBeNull();
  });

  it('omits an empty summary', async () => {
    const r = await store.startReview();
    expect((await store.submitReview(r.id, '   ')).summary).toBeUndefined();
  });

  it('only accepts drafts from the user, in the review in progress', async () => {
    const t = await store.createThread(anchor(), { author: 'user', body: 'published', reviewId: null });
    await expect(
      store.addComment(t.id, { author: 'user', body: 'x', reviewId: 'r_00000000000000000000000000' }),
    ).rejects.toThrow(/Review not found/);
    const r = await store.startReview();
    await expect(
      store.addComment(t.id, { author: 'agent', agent: 'Claude', body: 'x', reviewId: r.id }),
    ).rejects.toThrow(/Only the user/);
    await store.submitReview(r.id);
    await expect(store.addComment(t.id, { author: 'user', body: 'late', reviewId: r.id })).rejects.toThrow(
      /already submitted/,
    );
    await expect(store.submitReview(r.id)).rejects.toThrow(/already submitted/);
  });

  it('hides threads that only hold drafts from the agent', async () => {
    const r = await store.startReview();
    const t = await store.createThread(anchor(), { author: 'user', body: 'draft', reviewId: r.id });
    await expect(
      store.addComment(t.id, { author: 'agent', agent: 'Claude', body: 'hi', reviewId: null }),
    ).rejects.toThrow(/Thread not found/);
    await expect(store.setStatus(t.id, 'addressed', 'agent', 'Claude')).rejects.toThrow(/Thread not found/);
    await store.submitReview(r.id);
    expect(
      (await store.addComment(t.id, { author: 'agent', agent: 'Claude', body: 'hi', reviewId: null })).comments,
    ).toHaveLength(2);
  });

  it('reads review journals tolerantly', async () => {
    const r = await store.startReview();
    await writeFile(store.reviewFile(r.id), 'garbage\n', { flag: 'a' });
    const { reviews, warnings } = await store.loadReviews();
    expect(reviews.get(r.id)!.state).toBe('active');
    expect(warnings).toHaveLength(1);
    expect(() => store.reviewFile('../x')).toThrow(/Invalid review id/);
  });
});

describe('Store — discard and draft replies', () => {
  let root: string;
  let store: Store;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lr-core-'));
    store = new Store(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('drops the drafts of a discarded review; draft-only threads disappear', async () => {
    const published = await store.createThread(anchor(), { author: 'user', body: 'published', reviewId: null });
    const r = await store.startReview();
    await store.addComment(published.id, { author: 'user', body: 'draft reply', reviewId: r.id });
    const draftOnly = await store.createThread(anchor(), { author: 'user', body: 'draft', reviewId: r.id });

    expect(await store.discardReview(r.id)).toMatchObject({ state: 'discarded' });
    const { threads } = await store.loadAll();
    expect(threads.map((t) => t.id)).toEqual([published.id]);
    expect(threads[0]!.comments.map((c) => c.body)).toEqual(['published']);
    expect((await store.loadThread(draftOnly.id)).state!.deleted).toBe(true);
    expect(await store.activeReview()).toBeNull();
    await expect(store.discardReview(r.id)).rejects.toThrow(/already discarded/);
  });

  it('keeps a draft reply hidden in a published thread until submit, then hands the thread back', async () => {
    const t = await store.createThread(anchor(), { author: 'user', body: 'q', reviewId: null });
    await store.addComment(
      t.id,
      { author: 'agent', agent: 'Claude', body: 'Which one?', reviewId: null },
      { status: 'needs-info' },
    );
    const r = await store.startReview();
    const drafted = await store.addComment(t.id, { author: 'user', body: 'This one', reviewId: r.id });
    expect(drafted.status).toBe('needs-info'); // nothing changes for the agent yet
    expect(drafted.comments.map((c) => c.isDraft)).toEqual([false, false, true]);
    expect(drafted.hasPublished).toBe(true);

    await store.submitReview(r.id);
    const after = (await store.loadThread(t.id)).state!;
    expect(after.status).toBe('open');
    expect(after.comments.map((c) => c.isDraft)).toEqual([false, false, false]);
  });

  it('does not touch the status of threads without replies in the review', async () => {
    const t = await store.createThread(anchor(), { author: 'user', body: 'q', reviewId: null });
    await store.setStatus(t.id, 'addressed', 'agent', 'Claude');
    const r = await store.startReview();
    await store.createThread(anchor(), { author: 'user', body: 'other', reviewId: r.id });
    await store.submitReview(r.id);
    expect((await store.loadThread(t.id)).state!.status).toBe('addressed');
  });
});

describe('agent view', () => {
  let root: string;
  let store: Store;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lr-core-'));
    store = new Store(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('shows published comments only, and whose turn it is', async () => {
    const t = await store.createThread(anchor(), { author: 'user', body: 'q', reviewId: null });
    expect(agentView(t)).toMatchObject({ needsAgent: true, waitsForUser: false });

    const answered = await store.addComment(
      t.id,
      { author: 'agent', agent: 'Claude', body: 'a', reviewId: null },
      { status: 'needs-info' },
    );
    expect(agentView(answered)).toMatchObject({ needsAgent: false, waitsForUser: true });

    const r = await store.startReview();
    const withDraft = await store.addComment(t.id, { author: 'user', body: 'draft', reviewId: r.id });
    const view = agentView(withDraft)!;
    expect(view.comments.map((c) => c.body)).toEqual(['q', 'a']);
    expect(view.needsAgent).toBe(false); // the draft is not published yet
  });

  it('hides draft-only, resolved-for-action and deleted threads', async () => {
    const r = await store.startReview();
    const draftOnly = await store.createThread(anchor(), { author: 'user', body: 'draft', reviewId: r.id });
    expect(agentView(draftOnly)).toBeNull();

    const t = await store.createThread(anchor(), { author: 'user', body: 'q', reviewId: null });
    const resolved = await store.setStatus(t.id, 'resolved', 'user');
    expect(agentView(resolved)).toMatchObject({ needsAgent: false, waitsForUser: false });
    expect(agentView(await store.deleteThread(t.id, 'user'))).toBeNull();
  });

  it('finds the store from a subdirectory', async () => {
    await store.createThread(anchor(), { author: 'user', body: 'q', reviewId: null });
    await mkdir(join(root, 'src', 'deep'), { recursive: true });
    expect(findStoreRoot(join(root, 'src', 'deep'))).toBe(root);
    expect(findStoreRoot(tmpdir())).toBeNull();
  });

  it('never takes the per-machine folder (~/.local-review, sessions only) for a store', async () => {
    // A home holding the session registry, a project below it without any store.
    const home = join(root, 'home');
    const machine = join(home, '.local-review');
    await mkdir(join(machine, 'sessions'), { recursive: true });
    await mkdir(join(home, 'projects', 'app'), { recursive: true });
    const env = { LOCAL_REVIEW_HOME: machine };
    expect(findStoreRoot(join(home, 'projects', 'app'), env)).toBeNull();

    // Even if it happened to hold threads: it is still the machine folder.
    await mkdir(join(machine, 'threads'));
    expect(findStoreRoot(join(home, 'projects', 'app'), env)).toBeNull();
  });

  it('does not take an empty .local-review folder for a store', async () => {
    await mkdir(join(root, 'other', '.local-review'), { recursive: true });
    expect(findStoreRoot(join(root, 'other'), { LOCAL_REVIEW_HOME: join(root, 'nowhere') })).toBeNull();
  });

  it('finds the stores below a parent folder', async () => {
    const parent = join(root, 'parent');
    for (const repo of ['a', 'b/nested']) {
      await new Store(join(parent, repo)).createThread(anchor(), { author: 'user', body: 'q', reviewId: null });
    }
    await mkdir(join(parent, 'node_modules', 'x', '.local-review', 'threads'), { recursive: true });
    const env = { LOCAL_REVIEW_HOME: join(root, 'nowhere') };
    expect(findStoresBelow(parent, 3, env)).toEqual([join(parent, 'a'), join(parent, 'b', 'nested')]);
  });
});

describe('Store — branches', () => {
  let dir: string;
  let store: Store;
  const A = { repo: '/r/.git', branch: 'a', worktree: '/r' };
  const B = { repo: '/r/.git', branch: 'b', worktree: '/r/wt-b' };
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lr-branch-'));
    store = new Store(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps the branch of a thread, and follows it when renamed', async () => {
    const t = await store.createThread(anchor(), { author: 'user', body: 'x', reviewId: null }, A);
    expect(t.branch).toEqual(A);
    const renamed = await store.setBranch(t.id, { ...A, branch: 'a2' });
    expect(renamed.branch?.branch).toBe('a2');
    const outside = await store.createThread(anchor(), { author: 'user', body: 'y', reviewId: null });
    expect(outside.branch).toBeNull();
  });

  it('has one review in progress per branch', async () => {
    const ra = await store.startReview(A);
    const rb = await store.startReview(B);
    expect(ra.id).not.toBe(rb.id);
    expect((await store.startReview(A)).id).toBe(ra.id);
    expect((await store.activeReview(B))?.id).toBe(rb.id);
    expect(await store.activeReview(null)).toBeNull();
    expect((await store.activeReviews()).map((r) => r.branch?.branch).sort()).toEqual(['a', 'b']);

    await store.setReviewBranch(ra.id, { ...A, branch: 'a2' });
    expect((await store.activeReview({ ...A, branch: 'a2' }))?.id).toBe(ra.id);
    await store.submitReview(rb.id);
    expect((await store.activeReviews()).map((r) => r.branch?.branch)).toEqual(['a2']);
  });

  it('has one review in progress per folder off any branch', async () => {
    const r1 = await store.startReview(null, 'notes');
    const r2 = await store.startReview(null, 'specs');
    expect(r1.id).not.toBe(r2.id);
    expect(r1).toMatchObject({ branch: null, path: 'notes' });
    expect((await store.startReview(null, 'notes')).id).toBe(r1.id);
    expect((await store.activeReview(null, 'specs'))?.id).toBe(r2.id);
    expect(await store.activeReview(null)).toBeNull();
    expect((await store.activeReviews()).map((r) => r.path).sort()).toEqual(['notes', 'specs']);

    // On a branch, the review is the branch's: the folder does not count.
    const ra = await store.startReview(A, 'notes');
    expect(ra).toMatchObject({ branch: A, path: null });
    expect((await store.startReview(A, 'specs')).id).toBe(ra.id);
  });

  it('keeps a review started off any branch before folders had their own, for no file', async () => {
    const legacy = await store.startReview(null);
    expect(legacy.path).toBeNull();
    expect((await store.startReview(null, 'notes')).id).not.toBe(legacy.id);
    expect((await store.activeReviews()).map((r) => r.id)).toContain(legacy.id);
  });
});

describe('Changes to what the user asked', () => {
  let dir: string;
  let store: Store;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lr-rev-'));
    store = new Store(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const rev = (t: ThreadState) => agentView(t)!.rev;

  it('has a version that changes with the user, not with the agent or the code', async () => {
    const t = await store.createThread(anchor(), { author: 'user', body: 'Rename XXX to YYY', reviewId: null });
    const first = rev(t);
    const replied = await store.addComment(t.id, { author: 'agent', agent: 'Claude', body: 'Done', reviewId: null });
    expect(rev(replied)).toBe(first);
    const moved = await store.updateAnchor(t.id, { ...t.anchor, range: { startLine: 5, endLine: 5 } }, 'user');
    expect(rev(moved)).toBe(first);
    const edited = await store.editComment(t.id, t.comments[0]!.id, 'Rename XXX to GGG', 'user');
    expect(rev(edited)).not.toBe(first);
    const more = await store.addComment(t.id, { author: 'user', body: 'And add a test', reviewId: null });
    expect(rev(more)).not.toBe(rev(edited));
  });

  it('hands a handled thread back to the agent when the user edits a published comment', async () => {
    const t = await store.createThread(anchor(), { author: 'user', body: 'Rename XXX to YYY', reviewId: null });
    await store.addComment(
      t.id,
      { author: 'agent', agent: 'Claude', body: 'Done', reviewId: null },
      { status: 'addressed' },
    );
    const edited = await store.editComment(t.id, t.comments[0]!.id, 'Rename XXX to GGG', 'user');
    expect(edited.status).toBe('open');
    // The agent spoke last, but about the old version: its turn again.
    expect(agentView(edited)!.needsAgent).toBe(true);
    expect(agentView(edited)!.waitsForUser).toBe(false);
  });
});

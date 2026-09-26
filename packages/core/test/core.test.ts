import { mkdtemp, readFile, rm, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildAnchorContext,
  foldThread,
  parseJournal,
  serializeEvents,
  Store,
  ulid,
  newThreadId,
  type Anchor,
  type ReviewState,
  type ThreadEvent,
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
  v: 1, type: 'thread.created', at: '2026-09-26T10:00:00.000Z', by: 'user', threadId: 't_1', anchor: a,
});
const added = (id: string, by: 'user' | 'claude', body: string, reviewId: string | null = null): ThreadEvent => ({
  v: 1, type: 'comment.added', at: '2026-09-26T10:01:00.000Z', by, commentId: id, body, reviewId,
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
      added('c_2', 'claude', 'why?'),
      { v: 1, type: 'comment.edited', at: 't', by: 'user', commentId: 'c_1', body: 'hello' },
      { v: 1, type: 'status.changed', at: 't', by: 'claude', status: 'needs-info' },
      { v: 1, type: 'anchor.updated', at: 't', by: 'user', anchor: moved },
    ])!;
    expect(s.comments.map((c) => c.body)).toEqual(['hello', 'why?']);
    expect(s.comments[0]!.editedAt).toBe('t');
    expect(s.status).toBe('needs-info');
    expect(s.lastAuthor).toBe('claude');
    expect(s.anchor.range).toEqual({ startLine: 15, endLine: 17 });

    const d = foldThread([created(), added('c_1', 'user', 'hi'), { v: 1, type: 'thread.deleted', at: 't', by: 'user' }])!;
    expect(d.deleted).toBe(true);
  });

  it('refuses edits and deletions by another author', () => {
    const s = foldThread([
      created(),
      added('c_1', 'user', 'hi'),
      { v: 1, type: 'comment.edited', at: 't', by: 'claude', commentId: 'c_1', body: 'hacked' },
      { v: 1, type: 'comment.deleted', at: 't', by: 'claude', commentId: 'c_1' },
    ])!;
    expect(s.comments.map((c) => c.body)).toEqual(['hi']);
  });

  it('computes drafts from review states', () => {
    const reviews = new Map<string, ReviewState>([
      ['r_active', { id: 'r_active', state: 'active', startedAt: 't' }],
      ['r_done', { id: 'r_done', state: 'submitted', startedAt: 't' }],
      ['r_gone', { id: 'r_gone', state: 'discarded', startedAt: 't' }],
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
    expect(await store.loadAll()).toEqual({ threads: [], warnings: [] });
    expect(await readdir(root)).toEqual([]);
  });

  it('creates a thread as one journal with two events, plus schema-version', async () => {
    const store = new Store(root);
    const state = await store.createThread(anchor(), { author: 'user', body: '  Hello **world**  ', reviewId: null });

    const lines = (await readFile(store.threadFile(state.id), 'utf8')).trimEnd().split('\n').map((l) => JSON.parse(l));
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
    await expect(new Store(root).createThread(anchor(), { author: 'user', body: '   ', reviewId: null })).rejects.toThrow(
      /empty/,
    );
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

  it('adds a Claude reply and its status in a single write', async () => {
    const t = await newThread();
    const s = await store.addComment(t.id, { author: 'claude', body: 'Which error?', reviewId: null }, { status: 'needs-info' });
    expect(s.comments.map((c) => [c.author, c.body])).toEqual([
      ['user', 'Why null here?'],
      ['claude', 'Which error?'],
    ]);
    expect(s.status).toBe('needs-info');
    expect(s.lastAuthor).toBe('claude');

    const lines = (await readFile(store.threadFile(t.id), 'utf8')).trimEnd().split('\n');
    expect(lines.map((l) => JSON.parse(l).type)).toEqual(['thread.created', 'comment.added', 'comment.added', 'status.changed']);
  });

  it('adds a reply without changing the status', async () => {
    const t = await newThread();
    const s = await store.addComment(t.id, { author: 'claude', body: 'Noted.', reviewId: null });
    expect(s.status).toBe('open');
  });

  it('sets a status on its own', async () => {
    const t = await newThread();
    expect((await store.setStatus(t.id, 'addressed', 'claude')).status).toBe('addressed');
    expect((await store.loadThread(t.id)).state!.status).toBe('addressed');
  });

  it('never lets Claude resolve a thread', async () => {
    const t = await newThread();
    await expect(store.setStatus(t.id, 'resolved', 'claude')).rejects.toThrow(/Only the user/);
    await expect(
      store.addComment(t.id, { author: 'claude', body: 'done', reviewId: null }, { status: 'resolved' }),
    ).rejects.toThrow(/Only the user/);
    expect((await store.loadThread(t.id)).state!.comments).toHaveLength(1);
  });

  it('refuses to write to unknown, deleted or read-only threads', async () => {
    await expect(
      store.addComment('t_00000000000000000000000000', { author: 'claude', body: 'x', reviewId: null }),
    ).rejects.toThrow(/not found/);

    const t = await newThread();
    await writeFile(store.threadFile(t.id), JSON.stringify({ v: 99, type: 'future' }) + '\n', { flag: 'a' });
    await expect(store.addComment(t.id, { author: 'claude', body: 'x', reviewId: null })).rejects.toThrow(/read-only/);
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

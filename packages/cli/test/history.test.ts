import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildAnchorContext,
  looseStore,
  serializeEvents,
  Store,
  type Anchor,
  type ThreadEvent,
  formatBytes,
} from '@silykat/core';
import { EXIT, parseSince, runCli } from '../src/cli';

const CODE = ['export function find(id: string) {', '  const user = db.get(id);', '  if (!user) return null;', '}'];

let base: string;
const env = () => ({ SILYKAT_HOME: join(base, 'machine') });

async function slk(args: string[], cwd = base) {
  let out = '';
  let err = '';
  const code = await runCli(args, {
    cwd,
    env: env(),
    out: (t) => (out += t + '\n'),
    err: (t) => (err += t + '\n'),
    readStdin: async () => '',
    ancestors: async () => [],
  });
  return { code, out, err };
}

const anchorOn = (startLine: number, endLine: number, over: Partial<Anchor> = {}): Anchor => ({
  path: 'src/find.ts',
  source: 'worktree',
  ref: null,
  sha: null,
  ...buildAnchorContext(CODE.join('\n'), { startLine, endLine }),
  ...over,
});

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'slk-history-cli-')));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** A project with two repositories: a resolved thread, a deleted one, and one the agent addressed. */
async function project() {
  const api = new Store(join(base, 'api'));
  const web = new Store(join(base, 'web'));
  const resolved = await api.createThread(anchorOn(3, 3), { author: 'user', body: 'Throw here', reviewId: null });
  await api.addComment(
    resolved.id,
    { author: 'agent', agent: 'Claude', body: 'Done.', reviewId: null },
    {
      status: 'addressed',
    },
  );
  await api.setStatus(resolved.id, 'resolved', 'user');
  const deleted = await api.createThread(anchorOn(1, 2), { author: 'user', body: 'Rename it', reviewId: null });
  await api.deleteThread(deleted.id, 'user');
  const whole = await web.createThread(anchorOn(1, 1, { path: 'README.md', range: null }), {
    author: 'user',
    body: 'Explain the setup',
    reviewId: null,
  });
  await web.addComment(
    whole.id,
    { author: 'agent', agent: 'Claude', body: 'Which one?', reviewId: null },
    {
      status: 'needs-info',
    },
  );
  return { resolved, deleted, whole };
}

describe('slk review history', () => {
  it('lists every thread of the project in markdown, whatever its state, after a summary', async () => {
    const { resolved, deleted, whole } = await project();
    const { code, out } = await slk(['review', 'history']);
    expect(code).toBe(EXIT.OK);
    expect(out).toContain(`# silykat history — ${base}`);
    expect(out).toMatch(/Whole history · 3 threads · [\d.]+ KB of journals/);
    expect(out).toContain('0 open · 1 needs-info · 0 addressed · 1 resolved · 1 deleted (1 removed by the user)');
    expect(out).toContain('| Store | Found as | Threads | open | needs-info | addressed | resolved | deleted | Size |');
    expect(out).toMatch(/\| api \| subfolder \| 2 \| 0 \| 0 \| 0 \| 1 \| 1 \| [\d.]+ KB \|/);
    expect(out).toMatch(/\| web \| subfolder \| 1 \| 0 \| 1 \| 0 \| 0 \| 0 \|/);

    expect(out).toContain(`### ${resolved.id} — src/find.ts:3 · resolved`);
    expect(out).toContain('```ts\n3 |   if (!user) return null;\n```');
    expect(out).toMatch(/\*\*User\*\* \([^)]+\):\nThrow here/);
    expect(out).toMatch(/\*\*Claude\*\* \([^)]+\):\nDone\./);
    expect(out).toMatch(/_Status → addressed \(Claude, [^)]+\)_/);
    expect(out).toMatch(/_Status → resolved \(User, [^)]+\)_/);
    expect(out).toContain(`### ${deleted.id} — src/find.ts:1-2 · deleted`);
    expect(out).toMatch(/_Thread deleted: removed by the user \([^)]+\)_/);
    expect(out).toContain('Store: api · Deleted: removed by the user');
    expect(out).toContain(`### ${whole.id} — README.md (whole file) · needs-info`);
    expect(out).toContain('Store: web');
  });

  it('gives tools the same in JSON: a summary, then each thread with its whole conversation', async () => {
    const { resolved, deleted } = await project();
    const { code, out } = await slk(['review', 'history', '--format', 'json']);
    expect(code).toBe(EXIT.OK);
    const h = JSON.parse(out);
    expect(h.root).toBe(base);
    expect(h.since).toBeNull();
    expect(h.summary).toMatchObject({ threads: 3, states: { resolved: 1, deleted: 1, 'needs-info': 1 } });
    expect(
      h.summary.stores.map((s: { label: string; origin: string; threads: number }) => [s.label, s.origin, s.threads]),
    ).toEqual([
      ['api', 'below', 2],
      ['web', 'below', 1],
    ]);
    expect(h.summary.bytes).toBe(h.threads.reduce((n: number, t: { bytes: number }) => n + t.bytes, 0));
    const r = h.threads.find((t: { id: string }) => t.id === resolved.id);
    expect(r).toMatchObject({
      store: join(base, 'api'),
      state: 'resolved',
      path: 'src/find.ts',
      range: { startLine: 3, endLine: 3 },
      code: '  if (!user) return null;',
      branch: null,
      deletedAt: null,
    });
    expect(
      r.conversation.map((e: { type: string; author?: string; by?: string; status?: string }) => [
        e.type,
        e.author ?? e.by,
        e.status,
      ]),
    ).toEqual([
      ['comment', 'user', undefined],
      ['comment', 'Claude', undefined],
      ['status', 'Claude', 'addressed'],
      ['status', 'user', 'resolved'],
    ]);
    const d = h.threads.find((t: { id: string }) => t.id === deleted.id);
    expect(d.state).toBe('deleted');
    expect(d.deletedAt).toEqual(expect.any(String));
    expect(d.deletedReason).toBe('user');
    expect(d.conversation.at(-1)).toMatchObject({ type: 'deleted', by: 'user', reason: 'user' });
    expect(h.summary.deletions).toEqual({ user: 1, 'branch-gone': 0, unknown: 0 });
  });

  it('keeps the threads active since a date', async () => {
    const store = new Store(base);
    await mkdir(store.threadsDir, { recursive: true });
    const thread = (id: string, at: string): ThreadEvent[] => [
      { v: 1, type: 'thread.created', at, by: 'user', threadId: id, anchor: anchorOn(3, 3) },
      { v: 1, type: 'comment.added', at, by: 'user', commentId: `c_${id}`, body: `said ${at}`, reviewId: null },
    ];
    const old = 't_01ARZ3NDEKTSV4RRFFQ69G5FA1';
    const recent = 't_01ARZ3NDEKTSV4RRFFQ69G5FA2';
    await writeFile(store.threadFile(old), serializeEvents(thread(old, '2026-09-01T10:00:00.000Z')));
    await writeFile(store.threadFile(recent), serializeEvents(thread(recent, '2026-09-29T10:00:00.000Z')));
    const { out } = await slk(['review', 'history', '--since', '2026-09-20T00:00:00Z', '--format', 'json']);
    const h = JSON.parse(out);
    expect(h.since).toBe('2026-09-20T00:00:00.000Z');
    expect(h.threads.map((t: { id: string }) => t.id)).toEqual([recent]);
    const md = (await slk(['review', 'history', '--since', '2026-09-20T00:00:00Z'])).out;
    expect(md).toContain('Since 2026-09-20T00:00:00.000Z · 1 thread ·');
    expect((await slk(['review', 'history', '--since', '2026-10-01T00:00:00Z'])).out).toContain(
      'No thread was active in this period.',
    );
  });

  it('reads the project of --root, and says when it has no comments', async () => {
    await project();
    expect((await slk(['review', 'history', '--root', 'api'])).out).toContain('2 threads');
    await mkdir(join(base, 'empty'));
    const { code, out } = await slk(['review', 'history'], join(base, 'empty'));
    expect(code).toBe(EXIT.OK);
    expect(out).toContain('No comment store in this folder, its subfolders or the worktrees of its repositories.');
    expect(JSON.parse((await slk(['review', 'history', '--format', 'json'], join(base, 'empty'))).out).threads).toEqual(
      [],
    );
  });

  it('reads the files outside any open folder with --root /', async () => {
    await looseStore(env()).createThread(anchorOn(3, 3, { path: '/specs/find.ts' }), {
      author: 'user',
      body: 'Loose',
      reviewId: null,
    });
    const { out } = await slk(['review', 'history', '--root', '/']);
    expect(out).toContain('| / (files outside any open folder) | this folder | 1 |');
    expect(out).toContain('/specs/find.ts:3 · open');
  });

  it('shows warnings, review submissions, edits and the version a thread is about', async () => {
    const store = new Store(base);
    const review = await store.startReview();
    const t = await store.createThread(
      anchorOn(3, 3, {
        source: 'git',
        ref: 'HEAD',
        sha: 'abc1234',
        diff: {
          side: 'base',
          base: { source: 'git', ref: 'HEAD', sha: 'abc1234' },
          head: { source: 'worktree', ref: null, sha: null },
        },
      }),
      { author: 'user', body: 'Draft', reviewId: review.id },
    );
    const commentId = (await store.loadThread(t.id)).state!.comments[0]!.id;
    await store.editComment(t.id, commentId, 'Reworded draft', 'user');
    await store.submitReview(review.id);
    // Rewording the draft was not an edit; changing the published comment is.
    await new Promise((r) => setTimeout(r, 5));
    await store.editComment(t.id, commentId, 'Final', 'user');
    await writeFile(join(store.threadsDir, 't_01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl'), 'not json\n');
    const { out } = await slk(['review', 'history']);
    expect(out).toMatch(/\*\*User\*\* \([^,]+, submitted in a review [^,]+, edited [^)]+\):\nFinal/);
    expect(out).toContain('About the version HEAD');
    expect(out).toContain('Made in a diff (old side)');
    expect(out).toContain('## Warnings');
    expect(out).toContain('- .: threads/t_01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl:1: invalid JSON, line skipped');
    const json = JSON.parse((await slk(['review', 'history', '--format', 'json'])).out);
    expect(json.threads[0]).toMatchObject({ diffSide: 'base', source: 'git', ref: 'HEAD' });
    expect(json.threads[0].conversation[0]).toMatchObject({
      publishedAt: expect.any(String),
      editedAt: expect.any(String),
    });
    expect(json.summary.stores[0].warnings).toHaveLength(2);
  });

  it('refuses a wrong date or format', async () => {
    const date = await slk(['review', 'history', '--since', 'last week']);
    expect(date.code).toBe(EXIT.ERROR);
    expect(date.err).toContain('--since must be a date');
    for (const wrong of ['7', '2026-02-30', '2026-13-01', '2026-10-01Tnoon'])
      expect((await slk(['review', 'history', '--since', wrong])).code).toBe(EXIT.ERROR);
    const positional = await slk(['review', 'history', '7d']);
    expect(positional.code).toBe(EXIT.ERROR);
    expect(positional.err).toContain('takes no argument');
    const format = await slk(['review', 'history', '--format', 'xml']);
    expect(format.code).toBe(EXIT.ERROR);
    expect(format.err).toContain('--format must be "md" or "json"');
  });
});

describe('parseSince', () => {
  it('reads a day (local midnight), a date and time, or a number of days ago', () => {
    expect(parseSince(undefined)).toBeNull();
    expect(parseSince('2026-10-01')!.getTime()).toBe(new Date(2026, 9, 1).getTime());
    expect(parseSince('2026-10-01T08:00:00Z')!.toISOString()).toBe('2026-10-01T08:00:00.000Z');
    expect(parseSince('7d', Date.UTC(2026, 9, 8))!.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });
});

describe('formatBytes', () => {
  it('writes sizes for people', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(3300)).toBe('3.3 KB');
    expect(formatBytes(1_250_000)).toBe('1.3 MB');
  });
});

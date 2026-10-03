import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildAnchorContext,
  RetroBook,
  serializeEvents,
  SessionRegistry,
  Store,
  type Anchor,
  type ThreadEvent,
} from '@local-review/core';
import { EXIT, runCli } from '../src/cli';

const CODE = ['export function find(id: string) {', '  return db.get(id);', '}'];

let root: string;
let store: Store;
const env = (extra: Record<string, string> = {}) => ({ LOCAL_REVIEW_HOME: join(root, 'machine'), ...extra });

async function lr(args: string[], opts: { env?: Record<string, string>; ancestors?: number[] } = {}) {
  let out = '';
  let err = '';
  const code = await runCli(args, {
    cwd: root,
    env: opts.env ?? env(),
    out: (t) => (out += t + '\n'),
    err: (t) => (err += t + '\n'),
    readStdin: async () => '',
    ancestors: async () => opts.ancestors ?? [],
  });
  return { code, out, err };
}

const anchor = (): Anchor => ({
  path: 'src/find.ts',
  source: 'worktree',
  ref: null,
  sha: null,
  ...buildAnchorContext(CODE.join('\n'), { startLine: 2, endLine: 2 }),
});

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'lr-link-')));
  store = new Store(root);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'find.ts'), CODE.join('\n') + '\n');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const SESSION = 'e3244e92-00ec-444d-8321-e34fa73fccbf';

async function inSession() {
  const registry = new SessionRegistry(join(root, 'machine'));
  await registry.register({
    id: SESSION,
    agent: 'Claude',
    cwd: root,
    branch: null,
    pid: process.pid, // alive for as long as the test runs
    startedAt: new Date().toISOString(),
  });
  return registry;
}

const lastComment = async (id: string) => {
  const history = JSON.parse((await lr(['history', '--format', 'json'])).out) as {
    threads: { id: string; conversation: { author: string; session?: unknown }[] }[];
  };
  return history.threads.find((t) => t.id === id)!.conversation.at(-1)!;
};

describe('the link between a reply and the agent conversation', () => {
  it('records the session lr reply runs in, and the tool call its adapter noted', async () => {
    const t = await store.createThread(anchor(), { author: 'user', body: 'Use cents', reviewId: null });
    const registry = await inSession();
    await registry.startCall(SESSION, {
      message: 'toolu_other',
      command: 'lr reply t_someone_else --body x',
      at: new Date().toISOString(),
    });
    await registry.startCall(SESSION, {
      message: 'toolu_mine',
      command: `lr reply ${t.id} --agent Claude --body Done`,
      at: new Date().toISOString(),
    });
    const r = await lr(['reply', t.id, '--agent', 'Claude', '--body', 'Done'], { ancestors: [123, process.pid] });
    expect(r.code).toBe(EXIT.OK);
    expect(await lastComment(t.id)).toMatchObject({
      author: 'Claude',
      session: { id: SESSION, message: 'toolu_mine' },
    });

    const md = (await lr(['history'])).out;
    expect(md).toContain(`session ${SESSION}, message toolu_mine`);
  });

  it('records the session alone when no call was noted', async () => {
    const t = await store.createThread(anchor(), { author: 'user', body: 'Use cents', reviewId: null });
    await inSession();
    await lr(['reply', t.id, '--agent', 'Claude', '--body', 'Done'], { ancestors: [process.pid] });
    expect((await lastComment(t.id)).session).toEqual({ id: SESSION });
    expect((await lr(['history'])).out).toMatch(new RegExp(`session ${SESSION}\\):`));
  });

  it('takes the session and the message given, for agents without an adapter', async () => {
    const t = await store.createThread(anchor(), { author: 'user', body: 'Use cents', reviewId: null });
    await lr(['reply', t.id, '--agent', 'Codex', '--body', 'Done', '--session', 'codex-1', '--message', 'm-7']);
    expect((await lastComment(t.id)).session).toEqual({ id: 'codex-1', message: 'm-7' });
    await lr(['reply', t.id, '--agent', 'Codex', '--body', 'Again'], { env: env({ LR_SESSION: 'codex-2' }) });
    expect((await lastComment(t.id)).session).toEqual({ id: 'codex-2' });
    // An id the registry cannot hold notes for is still recorded.
    await lr(['reply', t.id, '--agent', 'Codex', '--body', 'Once more', '--session', 'codex 3/x']);
    expect((await lastComment(t.id)).session).toEqual({ id: 'codex 3/x' });
  });

  it('replies as before outside any session, without a link', async () => {
    const t = await store.createThread(anchor(), { author: 'user', body: 'Use cents', reviewId: null });
    await inSession();
    const r = await lr(['reply', t.id, '--agent', 'Claude', '--body', 'Done'], { ancestors: [1234567] });
    expect(r.code).toBe(EXIT.OK);
    expect((await lastComment(t.id)).session).toBeUndefined();
    expect((await lr(['history'])).out).not.toContain('session');
  });

  it('never fails a reply for want of the session', async () => {
    const t = await store.createThread(anchor(), { author: 'user', body: 'Use cents', reviewId: null });
    // A registry that cannot be read: a file where its folder should be.
    await writeFile(join(root, 'machine'), 'not a folder');
    const r = await lr(['reply', t.id, '--agent', 'Claude', '--body', 'Done'], { ancestors: [process.pid] });
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toContain('Replied on');
  });

  it('reads journals written before the link, and ignores a malformed one', async () => {
    const at = '2026-10-01T10:00:00.000Z';
    const events: ThreadEvent[] = [
      { v: 1, type: 'thread.created', at, by: 'user', threadId: 't_old', anchor: anchor() },
      { v: 1, type: 'comment.added', at, by: 'user', commentId: 'c1', body: 'Old', reviewId: null },
      {
        v: 1,
        type: 'comment.added',
        at,
        by: 'agent',
        agent: 'Claude',
        commentId: 'c2',
        body: 'Old reply',
        reviewId: null,
      },
      {
        v: 1,
        type: 'comment.added',
        at,
        by: 'agent',
        agent: 'Claude',
        commentId: 'c3',
        body: 'Odd',
        reviewId: null,
        session: { id: 42 } as never,
      },
    ];
    await mkdir(join(root, '.local-review', 'threads'), { recursive: true });
    await writeFile(join(root, '.local-review', 'threads', 't_old.jsonl'), serializeEvents(events));
    const json = JSON.parse((await lr(['history', '--format', 'json'])).out) as {
      threads: { conversation: { session?: unknown }[] }[];
    };
    expect(json.threads[0]!.conversation.map((c) => c.session)).toEqual([undefined, undefined, undefined]);
    expect((await lr(['show', 't_old'])).code).toBe(EXIT.OK);
  });

  it('lists in lr retro show the conversations the analysis read back', async () => {
    const t = await store.createThread(anchor(), { author: 'user', body: 'Use cents', reviewId: null });
    const book = new RetroBook(root);
    const r = await book.start({
      root,
      since: null,
      until: new Date().toISOString(),
      stores: [{ root, origin: 'root', threads: 1, bytes: 1 }],
      threads: [t.id],
      bytes: 1,
    });
    await book.record(r.id, [
      { type: 'retro.conversation', thread: t.id, sessions: [SESSION], available: true },
      { type: 'retro.conversation', thread: 't_gone', sessions: ['old'], available: false },
    ]);
    const shown = (await lr(['retro', 'show', r.id])).out;
    expect(shown).toContain("## The agent's conversations read back");
    expect(shown).toContain(`- ${t.id}: read back`);
    expect(shown).toContain('- t_gone: no longer available (the agent deleted it), analysed without it');
    const json = JSON.parse((await lr(['retro', 'show', r.id, '--format', 'json'])).out) as {
      conversations: Record<string, { available: boolean }>;
    };
    expect(json.conversations[t.id]!.available).toBe(true);
  });
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAnchorContext, Store, type Anchor } from '@local-review/core';
import { EXIT, runCli } from '../src/cli';

const CODE = [
  'export function find(id: string) {',
  '  const user = db.get(id);',
  '  if (!user) return null;',
  '  return user;',
  '}',
];

let root: string;
let store: Store;

async function lr(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; stdin?: string; ancestors?: number[] } = {},
) {
  let out = '';
  let err = '';
  const code = await runCli(args, {
    cwd: opts.cwd ?? root,
    env: opts.env ?? {},
    out: (t) => (out += t + '\n'),
    err: (t) => (err += t + '\n'),
    readStdin: async () => opts.stdin ?? '',
    ancestors: async () => opts.ancestors ?? [],
  });
  return { code, out, err };
}

function anchorOn(startLine: number, endLine: number, over: Partial<Anchor> = {}): Anchor {
  return {
    path: 'src/find.ts',
    source: 'worktree',
    ref: null,
    sha: null,
    ...buildAnchorContext(CODE.join('\n'), { startLine, endLine }),
    ...over,
  };
}

const comment = (anchor: Anchor, body: string, reviewId: string | null = null) =>
  store.createThread(anchor, { author: 'user', body, reviewId });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lr-cli-'));
  store = new Store(root);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'find.ts'), CODE.join('\n') + '\n');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('lr list', () => {
  it('lists the threads where the user spoke last, with their code and conversation', async () => {
    const t = await comment(anchorOn(3, 3), 'Throw a NotFoundError instead of returning null');
    const { code, out } = await lr(['list']);
    expect(code).toBe(EXIT.OK);
    expect(out).toContain('# Local Review — 1 thread waiting for you');
    expect(out).toContain(`## ${t.id} — src/find.ts:3`);
    expect(out).toContain('```ts\n3 |   if (!user) return null;\n```');
    expect(out).toContain('**User**');
    expect(out).toContain('Throw a NotFoundError instead of returning null');
  });

  it('shows the code where it is now, after the file changed', async () => {
    await comment(anchorOn(3, 3), 'Throw here');
    await writeFile(join(root, 'src', 'find.ts'), ['// header', '// more', ...CODE].join('\n') + '\n');
    const { out } = await lr(['list']);
    expect(out).toContain('src/find.ts:5');
    expect(out).toContain('5 |   if (!user) return null;');
  });

  it('flags outdated threads with their recorded code', async () => {
    await comment(anchorOn(3, 3), 'Throw here');
    await writeFile(join(root, 'src', 'find.ts'), 'export const rewritten = true;\n');
    const { out } = await lr(['list']);
    expect(out).toContain('src/find.ts (outdated)');
    expect(out).toContain('⚠️ Outdated');
    expect(out).toContain('  if (!user) return null;');
  });

  it('leaves out drafts, threads waiting for the user, and resolved threads', async () => {
    const review = await store.startReview();
    await comment(anchorOn(1, 1), 'draft only', review.id);
    const answered = await comment(anchorOn(2, 2), 'question');
    await store.addComment(
      answered.id,
      { author: 'agent', agent: 'Claude', body: 'Which one?', reviewId: null },
      { status: 'needs-info' },
    );
    const resolved = await comment(anchorOn(4, 4), 'done');
    await store.setStatus(resolved.id, 'resolved', 'user');

    const { out } = await lr(['list']);
    expect(out).toContain('Nothing waits for you');

    const all = await lr(['list', '--all']);
    expect(all.out).toContain(answered.id);
    expect(all.out).not.toContain(resolved.id);
    expect(all.out).not.toContain('draft only');
  });

  it('includes the summary of the submitted review', async () => {
    const review = await store.startReview();
    await comment(anchorOn(3, 3), 'In the review', review.id);
    await store.submitReview(review.id, 'Overall: handle missing users everywhere');
    const { out } = await lr(['list']);
    expect(out).toContain('**Review summary**');
    expect(out).toContain('Overall: handle missing users everywhere');
  });

  it('says which version a git thread is about', async () => {
    await comment(
      anchorOn(3, 3, { source: 'git', ref: 'HEAD', sha: 'a92bf1ebf06d24c91791a89159ac0f0208895074' }),
      'Old code',
    );
    await comment(
      { ...anchorOn(1, 1), range: null, snippet: '', contextBefore: [], contextAfter: [] },
      'Split this file',
    );
    const { out } = await lr(['list']);
    expect(out).toContain('About the version HEAD a92bf1e, not the working tree');
    expect(out).toContain('src/find.ts (whole file)');
  });

  it('lists only the threads asked for', async () => {
    const a = await comment(anchorOn(1, 1), 'first');
    const b = await comment(anchorOn(2, 2), 'second');
    await comment(anchorOn(3, 3), 'third');
    const { out } = await lr(['list', '--thread', a.id, '--thread', b.id, '--format', 'json']);
    expect(
      JSON.parse(out)
        .map((t: { id: string }) => t.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
  });

  it('reads the machine store of the files outside any open folder with --root /', async () => {
    const env = { LOCAL_REVIEW_HOME: join(root, 'home') };
    const { looseStore } = await import('@local-review/core');
    const file = join(root, 'outside', 'spec.md');
    await mkdir(join(root, 'outside'), { recursive: true });
    await writeFile(file, 'First point\n');
    await looseStore(env).createThread(
      {
        path: file.slice(1),
        source: 'worktree',
        ref: null,
        sha: null,
        ...buildAnchorContext('First point\n', { startLine: 1, endLine: 1 }),
      },
      { author: 'user', body: 'Clarify', reviewId: null },
    );
    const { out } = await lr(['list', '--root', '/'], { env });
    expect(out).toContain('Clarify');
    expect(out).toContain('First point');
  });

  it('outputs JSON for tools', async () => {
    const t = await comment(anchorOn(3, 3), 'json please');
    const { out } = await lr(['list', '--format', 'json']);
    const [item] = JSON.parse(out);
    expect(item).toMatchObject({
      id: t.id,
      path: 'src/find.ts',
      range: { startLine: 3, endLine: 3 },
      needsAgent: true,
    });
    expect(item.comments[0]).toMatchObject({ author: 'user', body: 'json please' });
  });

  it('finds the store from a subdirectory, and says when there is none', async () => {
    await comment(anchorOn(3, 3), 'x');
    expect((await lr(['status'], { cwd: join(root, 'src') })).out).toContain('1 thread waiting for you');
    const none = await lr(['list'], { cwd: tmpdir() });
    expect(none.code).toBe(EXIT.ERROR);
    expect(none.err).toContain('no Local Review store in');
  });
});

describe('lr reply / set-status', () => {
  it('refuses a reply to a version of the thread the user changed since', async () => {
    const t = await comment(anchorOn(3, 3), 'Rename XXX to YYY');
    const [read] = JSON.parse((await lr(['list', '--format', 'json'])).out);
    expect((await lr(['list'])).out).toContain(`--rev ${read.rev}`);
    await store.editComment(t.id, t.comments[0]!.id, 'Rename XXX to GGG', 'user');

    const stale = await lr(['reply', t.id, '--agent', 'Claude', '--rev', read.rev, '--body', 'Done: YYY']);
    expect(stale.code).toBe(EXIT.CHANGED);
    expect(stale.err).toContain(`the user changed thread ${t.id} since you read it`);
    expect(stale.err).toContain('Rename XXX to GGG');
    expect((await store.loadThread(t.id)).state!.comments).toHaveLength(1); // nothing written

    const now = JSON.parse((await lr(['show', t.id, '--format', 'json'])).out).rev;
    const ok = await lr([
      'reply',
      t.id,
      '--agent',
      'Claude',
      '--rev',
      now,
      '--status',
      'addressed',
      '--body',
      'Done: GGG',
    ]);
    expect(ok.code).toBe(EXIT.OK);
    // Its own reply does not change the version.
    expect(JSON.parse((await lr(['show', t.id, '--format', 'json'])).out).rev).toBe(now);
  });

  it('says so when the user deleted the thread', async () => {
    const t = await comment(anchorOn(3, 3), 'Never mind');
    await store.deleteThread(t.id, 'user');
    const r = await lr(['reply', t.id, '--agent', 'Claude', '--body', 'Done']);
    expect(r.code).toBe(EXIT.NOT_FOUND);
    expect(r.err).toContain('was deleted by the user. Stop working on it');
    expect((await lr(['show', t.id])).err).toContain('was deleted by the user');
  });

  it('replies as the agent, with a status', async () => {
    const t = await comment(anchorOn(3, 3), 'Why null?');
    const { code, out } = await lr([
      'reply',
      t.id,
      '--agent',
      'Claude',
      '--body',
      'Which error?',
      '--status',
      'needs-info',
    ]);
    expect(code).toBe(EXIT.OK);
    expect(out).toContain('status: needs-info');
    const state = (await store.loadThread(t.id)).state!;
    expect(state.comments[1]).toMatchObject({ author: 'agent', agentName: 'Claude', body: 'Which error?' });
    expect((await lr(['status'])).out).toContain('0 threads waiting for you · 1 waiting for the user');
  });

  it('reads the body from a file or stdin, and the agent name from LR_AGENT', async () => {
    const t = await comment(anchorOn(3, 3), 'x');
    await writeFile(join(root, 'reply.md'), 'Done: it now throws `NotFoundError`.');
    await lr(['reply', t.id, '--body-file', 'reply.md', '--status', 'addressed'], { env: { LR_AGENT: 'Codex' } });
    await lr(['reply', t.id, '--agent', 'Claude', '--body', '-'], { stdin: 'from stdin' });
    const state = (await store.loadThread(t.id)).state!;
    expect(state.comments.slice(1).map((c) => [c.agentName, c.body])).toEqual([
      ['Codex', 'Done: it now throws `NotFoundError`.'],
      ['Claude', 'from stdin'],
    ]);
    expect(state.status).toBe('addressed');
  });

  it('sets a status', async () => {
    const t = await comment(anchorOn(3, 3), 'x');
    expect((await lr(['set-status', t.id, 'addressed', '--agent', 'Claude'])).code).toBe(EXIT.OK);
    expect((await store.loadThread(t.id)).state!.status).toBe('addressed');
  });

  it('never lets an agent resolve, reply anonymously, or reply empty', async () => {
    const t = await comment(anchorOn(3, 3), 'x');
    expect((await lr(['set-status', t.id, 'resolved', '--agent', 'Claude'])).err).toContain(
      '"addressed" or "needs-info"',
    );
    expect((await lr(['reply', t.id, '--body', 'hi'])).err).toContain('--agent');
    expect((await lr(['reply', t.id, '--agent', 'Claude', '--body', '  '])).code).toBe(EXIT.ERROR);
    expect((await store.loadThread(t.id)).state!.comments).toHaveLength(1);
  });

  it('exits with NOT_FOUND for a deleted or unknown thread', async () => {
    const t = await comment(anchorOn(3, 3), 'x');
    await store.deleteThread(t.id, 'user');
    const r = await lr(['reply', t.id, '--agent', 'Claude', '--body', 'late']);
    expect(r.code).toBe(EXIT.NOT_FOUND);
    expect((await lr(['show', 't_00000000000000000000000000'])).code).toBe(EXIT.NOT_FOUND);
  });
});

describe('lr show / usage', () => {
  it('shows one thread', async () => {
    const t = await comment(anchorOn(2, 3), 'Look at these two lines');
    const { out } = await lr(['show', t.id]);
    expect(out).toContain(`## ${t.id} — src/find.ts:2-3`);
  });

  it('prints the usage', async () => {
    expect((await lr(['--help'])).out).toContain('lr reply <thread-id>');
    expect((await lr(['nope'])).code).toBe(EXIT.ERROR);
  });

  it('keeps journals intact: replies are appended', async () => {
    const t = await comment(anchorOn(3, 3), 'x');
    await lr(['reply', t.id, '--agent', 'Claude', '--body', 'y']);
    const lines = (await readFile(store.threadFile(t.id), 'utf8')).trimEnd().split('\n');
    expect(lines.map((l) => JSON.parse(l).type)).toEqual(['thread.created', 'comment.added', 'comment.added']);
  });
});

describe('lr sessions', () => {
  it('registers, lists and unregisters sessions in LOCAL_REVIEW_HOME', async () => {
    const env = { LOCAL_REVIEW_HOME: join(root, 'home') };
    expect((await lr(['sessions'], { env })).out).toContain('No agent session is running');

    const reg = await lr(
      ['session', 'register', '--id', 'abc-12345', '--agent', 'Claude', '--cwd', 'src', '--branch', 'feature-x'],
      { env },
    );
    expect(reg.code).toBe(EXIT.OK);
    const listed = JSON.parse((await lr(['sessions', '--format', 'json'], { env })).out);
    expect(listed).toMatchObject([
      { id: 'abc-12345', agent: 'Claude', cwd: join(root, 'src'), branch: 'feature-x', pid: null, subscriptions: [] },
    ]);
    expect((await lr(['sessions'], { env })).out).toContain('Claude abc-1234 · feature-x');

    await lr(['session', 'unregister', '--id', 'abc-12345'], { env });
    expect((await lr(['sessions'], { env })).out).toContain('No agent session is running');
  });

  it('subscribes the session it runs in, found from its parent processes', async () => {
    const env = { LOCAL_REVIEW_HOME: join(root, 'home') };
    await lr(['session', 'register', '--id', 's-1', '--agent', 'Claude', '--cwd', '.', '--pid', String(process.pid)], {
      env,
    });
    const inSession = { env, ancestors: [100, process.pid, 1] }; // alive for as long as the test runs

    expect((await lr(['subscribe', 'src', '--path'], inSession)).out).toContain(`Subscribed to ${join(root, 'src')}.`);
    expect((await lr(['subscribe', 'src', '--path'], inSession)).out).toContain('Already subscribed');
    expect((await lr(['subscriptions'], inSession)).out).toContain(`${join(root, 'src')} (user)`);
    expect((await lr(['sessions'], { env })).out).toContain(`subscribed to ${join(root, 'src')} (user)`);
    expect((await lr(['unsubscribe', '--all'], inSession)).out).toContain('Unsubscribed from');
    expect((await lr(['subscriptions'], inSession)).out).toContain('subscribed to nothing');

    const outside = await lr(['subscribe'], { env, ancestors: [100, 200] });
    expect(outside.code).toBe(EXIT.ERROR);
    expect(outside.err).toContain('does not run in a registered agent session');
    expect((await lr(['subscribe', '--path'], { env: { ...env, LR_SESSION: 's-1' } })).code).toBe(EXIT.OK);
  });

  it('lists, in an agent session, only the threads of what it is subscribed to', async () => {
    const env = { LOCAL_REVIEW_HOME: join(root, 'home') };
    const A = { repo: '/r/.git', branch: 'a' };
    const onA = await store.createThread(anchorOn(1, 1), { author: 'user', body: 'on a', reviewId: null }, A);
    await store.createThread(anchorOn(2, 2), { author: 'user', body: 'on b', reviewId: null }, { ...A, branch: 'b' });
    await lr(['session', 'register', '--id', 's-2', '--agent', 'Claude', '--cwd', '.', '--pid', String(process.pid)], {
      env,
    });
    const inSession = { env, ancestors: [process.pid] };
    const ids = async (args: string[]) =>
      JSON.parse((await lr(['list', '--format', 'json', ...args], inSession)).out).map((t: { id: string }) => t.id);

    expect(await ids([])).toEqual([]); // subscribed to nothing
    expect((await lr(['status'], inSession)).out).toContain('subscribed to nothing');
    const { SessionRegistry } = await import('@local-review/core');
    await new SessionRegistry(env.LOCAL_REVIEW_HOME).subscribe('s-2', { kind: 'branch', ...A }, 'user');
    expect(await ids([])).toEqual([onA.id]);
    expect((await ids(['--any-topic'])).length).toBe(2);
    expect((await lr(['list'], inSession)).out).toContain('Showing only what this session is subscribed to: r · a');
    expect((await lr(['list'], { env })).out).toContain('on b'); // not in a session: everything
    await lr(['session', 'unregister', '--id', 's-2'], { env });
  });

  it('rejects bad input', async () => {
    const env = { LOCAL_REVIEW_HOME: join(root, 'home') };
    expect((await lr(['session', 'register', '--agent', 'Claude'], { env })).err).toContain('--id');
    expect((await lr(['session', 'register', '--id', 'x', '--agent', 'Claude', '--pid', 'abc'], { env })).code).toBe(
      EXIT.ERROR,
    );
    expect((await lr(['session', 'fly', '--id', 'x'], { env })).code).toBe(EXIT.ERROR);
    expect((await lr(['session', 'register', '--id', 'x', '--agent', 'A', '--push', 'maybe'], { env })).code).toBe(
      EXIT.ERROR,
    );
  });

  it('records whether deliveries reach the agent on their own', async () => {
    const env = { LOCAL_REVIEW_HOME: join(root, 'home') };
    await lr(
      [
        'session',
        'register',
        '--id',
        'p1',
        '--agent',
        'A',
        '--cwd',
        '.',
        '--push',
        'no',
        '--push-command',
        'Run a --live',
      ],
      { env },
    );
    expect(JSON.parse((await lr(['sessions', '--format', 'json'], { env })).out)).toMatchObject([
      { id: 'p1', push: false, pushCommand: 'Run a --live' },
    ]);
    expect((await lr(['sessions'], { env })).out).toContain('· no push');
    await lr(['session', 'unregister', '--id', 'p1'], { env });
  });
});

describe('lr from a folder without a store', () => {
  it('says so, instead of taking the per-machine folder for an empty store', async () => {
    // ~/.local-review holds the session registry, not comments.
    const home = join(root, 'home');
    await mkdir(join(home, '.local-review', 'sessions'), { recursive: true });
    await mkdir(join(home, 'work'), { recursive: true });
    const env = { LOCAL_REVIEW_HOME: join(home, '.local-review') };
    const r = await lr(['status'], { cwd: join(home, 'work'), env });
    expect(r.code).toBe(EXIT.ERROR);
    expect(r.err).toContain('no Local Review store in');
    expect(r.out).toBe('');
  });

  it('lists the stores below, e.g. the repositories of a parent folder', async () => {
    const repo = join(root, 'parent', 'repo');
    await new Store(repo).createThread(anchorOn(3, 3), { author: 'user', body: 'in the repo', reviewId: null });
    const env = { LOCAL_REVIEW_HOME: join(root, 'nowhere') };
    const r = await lr(['status'], { cwd: join(root, 'parent'), env });
    expect(r.code).toBe(EXIT.ERROR);
    expect(r.err).toContain('Stores below this folder');
    expect(r.err).toContain(repo);
    expect((await lr(['status', '--root', repo], { env })).out).toContain('1 thread waiting for you');
  });
});

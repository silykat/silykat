import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAnchorContext, readConfig, serializeEvents, Store, type Anchor } from '@local-review/core';
import { EXIT, runCli } from '../src/cli';

let base: string;
const env = () => ({ LOCAL_REVIEW_HOME: join(base, 'machine') });
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd, stdio: 'pipe' });
const anchor: Anchor = {
  path: 'a.txt',
  source: 'worktree',
  ref: null,
  sha: null,
  ...buildAnchorContext('one\ntwo\n', { startLine: 1, endLine: 1 }),
};

async function lr(args: string[], cwd = base) {
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

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'lr-keep-cli-')));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('lr worktree save', () => {
  it("saves a worktree's threads, which lr history still shows once the worktree is removed", async () => {
    const main = join(base, 'main');
    const wt = join(base, 'wt');
    await mkdir(main);
    git(main, 'init', '-q', '-b', 'main');
    await writeFile(join(main, 'a.txt'), 'one\ntwo\n');
    git(main, 'add', '.');
    git(main, 'commit', '-q', '-m', 'init');
    git(main, 'worktree', 'add', '-q', '-b', 'feat', wt);

    expect((await lr(['worktree', 'save'], wt)).out).toContain(`No comment in the worktree ${wt} (branch feat)`);
    const t = await new Store(wt).createThread(anchor, { author: 'user', body: 'Keep me', reviewId: null });
    const saved = await lr(['worktree', 'save'], wt);
    expect(saved.code).toBe(EXIT.OK);
    expect(saved.out).toContain(`Saved 1 thread of the worktree ${wt} (branch feat) to the store of ${main}:`);
    expect(saved.out).toContain('They stay in lr history and in retros after the worktree is removed.');
    const json = JSON.parse((await lr(['worktree', 'save', '../wt', '--format', 'json'], main)).out);
    expect(json).toMatchObject({ worktree: wt, main, published: 1 });

    git(main, 'worktree', 'remove', wt);
    const h = JSON.parse((await lr(['history', '--format', 'json'], main)).out);
    expect(h.threads.map((x: { id: string }) => x.id)).toEqual([t.id]);
    expect(h.threads[0].savedFrom).toMatchObject({ worktree: wt, branch: 'feat' });
    expect(h.summary.stores.map((s: { origin: string }) => s.origin)).toEqual(['root', 'saved']);
    const md = (await lr(['history'], main)).out;
    expect(md).toMatch(new RegExp(`\\| ${wt} \\(saved \\d{4}-\\d{2}-\\d{2}\\) \\| saved from a worktree \\| 1 \\|`));

    const refused = await lr(['worktree', 'save'], main);
    expect(refused.code).toBe(EXIT.ERROR);
    expect(refused.err).toContain('is the main worktree of its repository');
  });

  it('checks its arguments', async () => {
    expect((await lr(['worktree'])).err).toContain('lr worktree takes "save"');
    expect((await lr(['worktree', 'save', 'a', 'b'])).err).toContain('one folder at most');
  });
});

describe('lr history, deleted threads', () => {
  it('tells a thread removed by the user from one gone with its branch, and older ones', async () => {
    const store = new Store(base);
    const user = await store.createThread(anchor, { author: 'user', body: 'Never mind', reviewId: null });
    const branch = await store.createThread(anchor, { author: 'user', body: 'Merged', reviewId: null });
    await store.deleteThread(user.id, 'user');
    await store.deleteThread(branch.id, 'user', 'branch-gone');
    const old = 't_01ARZ3NDEKTSV4RRFFQ69G5FA1';
    await writeFile(
      store.threadFile(old),
      serializeEvents([
        { v: 1, type: 'thread.created', at: '2026-09-01T10:00:00.000Z', by: 'user', threadId: old, anchor },
        {
          v: 1,
          type: 'comment.added',
          at: '2026-09-01T10:00:00.000Z',
          by: 'user',
          commentId: 'c',
          body: 'Old',
          reviewId: null,
        },
        { v: 1, type: 'thread.deleted', at: '2026-09-02T10:00:00.000Z', by: 'user' },
      ]),
    );
    const md = (await lr(['history'])).out;
    expect(md).toContain('3 deleted (1 removed by the user, 1 with their branch, 1 reason unknown)');
    expect(md).toContain('Deleted: its branch was deleted');
    expect(md).toContain('_Thread deleted: reason unknown (2026-09-02T10:00:00.000Z)_');
    const h = JSON.parse((await lr(['history', '--format', 'json'])).out);
    expect(h.summary.deletions).toEqual({ user: 1, 'branch-gone': 1, unknown: 1 });
    const reasons = Object.fromEntries(
      h.threads.map((t: { id: string; deletedReason: string }) => [t.id, t.deletedReason]),
    );
    expect(reasons).toEqual({ [user.id]: 'user', [branch.id]: 'branch-gone', [old]: null });
    expect(h.threads.find((t: { id: string }) => t.id === old).conversation.at(-1)).toMatchObject({ reason: null });
  });
});

describe('lr config', () => {
  it('shows the settings of this machine and changes them', async () => {
    expect((await lr(['config'])).out).toContain('keep-history: on');
    expect((await lr(['config', 'set', 'keep-history', 'off'])).out).toBe(
      'keep-history is now off. Deleting a thread now erases it, and nothing is saved when an agent removes a worktree.\n',
    );
    expect(await readConfig(env())).toMatchObject({ keepHistory: false });
    expect(JSON.parse((await lr(['config', '--format', 'json'])).out)).toMatchObject({ keepHistory: false });
    expect((await lr(['config'])).out).toContain('keep-history: off');
    expect((await lr(['config'])).out).toContain('retro-sessions: reports');
    expect((await lr(['config', 'set', 'retro-sessions', 'insights'])).out).toBe('retro-sessions is now insights.\n');
    expect(await readConfig(env())).toMatchObject({ retroSessions: 'insights' });
  });

  it('refuses unknown settings and values', async () => {
    expect((await lr(['config', 'set', 'nope', 'on'])).err).toContain('unknown setting "nope"');
    expect((await lr(['config', 'set', 'keep-history', 'yes'])).err).toContain('takes "on" or "off"');
    expect((await lr(['config', 'set', 'retro-sessions', 'both'])).err).toContain(
      'retro-sessions takes reports or insights, not "both"',
    );
    expect((await lr(['config', 'get'])).err).toContain('lr config takes "set" or nothing');
  });
});

import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAnchorContext, RetroBook, Store, type Anchor } from '@local-review/core';
import type { Runner } from '../src/retroAudit';
import { runRetroCli } from '../src/retroCli';
import {
  countSessions,
  describeFields,
  FIELDS_FILE,
  inFolders,
  projectSessions,
  readFieldMaps,
  runInsights,
  shapeOf,
} from '../src/retroInsights';

let base: string;
let home: string;
let usage: string;
const env = () => ({ HOME: home, LOCAL_REVIEW_HOME: join(base, 'machine') });

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'lr-retro-insights-')));
  home = join(base, 'home');
  usage = join(home, '.claude', 'usage-data');
  await mkdir(join(usage, 'session-meta'), { recursive: true });
  await mkdir(join(usage, 'facets'), { recursive: true });
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const at = (day: number) => `2026-09-${String(day).padStart(2, '0')}T10:00:00.000Z`;

/** The facts `/insights` keeps for a session, and optionally its summary. */
async function session(id: string, folder: string, day: number, summary?: Record<string, unknown>) {
  const meta = {
    session_id: id,
    project_path: folder,
    start_time: at(day),
    user_message_count: 12,
    tool_counts: { Bash: 40, Edit: 3 },
    user_interruptions: 1,
    first_prompt: 'Fix the flaky tests',
    message_hours: [9, 10],
    transcript_mtime: 1790000000000,
  };
  await writeFile(join(usage, 'session-meta', `${id}.json`), JSON.stringify(meta));
  if (summary) await writeFile(join(usage, 'facets', `${id}.json`), JSON.stringify({ ...summary, session_id: id }));
}

const FACET = {
  underlying_goal: 'Fix flaky integration tests',
  friction_counts: { wrong_approach: 1 },
  friction_detail: 'The user rejected the first fix of the flaky tests.',
  brief_summary: 'Claude found the real bug behind the flaky tests.',
};

/** A fake Claude Code: `/insights` answers `insights`, the field mapping answers `fields`. */
function fakeClaude(insights: Partial<Awaited<ReturnType<Runner>>>, fields: Record<string, unknown> = {}) {
  const calls: { args: readonly string[]; cwd: string }[] = [];
  const runner: Runner = async (_cmd, args, { cwd }) => {
    calls.push({ args, cwd });
    if (args[1] === '/insights') return { stdout: '', stderr: '', code: 0, timedOut: false, ...insights };
    return { stdout: JSON.stringify({ result: JSON.stringify(fields) }), stderr: '', code: 0, timedOut: false };
  };
  return { runner, calls };
}
const done = (cost = 0.7, ms = 53_000) => ({
  stdout: JSON.stringify({ is_error: false, total_cost_usd: cost, duration_ms: ms }),
});

describe("the sessions of a project, from Claude Code's /insights", () => {
  it('keeps the sessions of the project and of the period, with their facts and summary', async () => {
    const root = join(base, 'work');
    await session('s-in', root, 20, FACET);
    await session('s-sub', join(root, 'api'), 21);
    await session('s-other', join(base, 'other'), 20, FACET);
    await session('s-sibling', `${root}-retro`, 20, FACET); // a folder whose name starts the same
    await session('s-old', root, 2, FACET);
    await writeFile(join(usage, 'session-meta', 'broken.json'), 'not json');
    const { runner, calls } = fakeClaude(done());

    const r = await projectSessions(usage, root, { since: at(10), until: at(30) }, env(), runner);
    expect(r).toMatchObject({ files: 5, read: 5 });
    expect(r.sessions.map((s) => s.id)).toEqual(['s-in', 's-sub']);
    const [s] = r.sessions;
    expect(s).toMatchObject({ id: 's-in', start: at(20), folder: root });
    expect(s!.summary).toMatchObject({ friction_detail: FACET.friction_detail });
    // Numbers and short texts, flattened; neither the keys nor the lists.
    expect(s!.facts).toEqual({
      user_message_count: 12,
      'tool_counts.Bash': 40,
      'tool_counts.Edit': 3,
      user_interruptions: 1,
      first_prompt: 'Fix the flaky tests',
    });
    expect(r.sessions[1]!.summary).toBeNull();
    expect(calls).toEqual([]); // the known format needs no model
    expect((await projectSessions(usage, root, { since: null, until: at(30) }, env(), runner)).sessions).toHaveLength(
      3,
    );
  });

  it('learns the fields of a new format once, from their shapes only, and keeps them for this machine', async () => {
    const root = join(base, 'work');
    const meta = { sessionId: 's-new', cwd: root, startedAt: at(20), turns: 3 };
    await writeFile(join(usage, 'session-meta', 's-new.json'), JSON.stringify(meta));
    await writeFile(join(usage, 'facets', 's-new.json'), JSON.stringify(FACET));
    const fields = { session_id: 'sessionId', project_path: 'cwd', start_time: 'startedAt' };
    const { runner, calls } = fakeClaude(done(), fields);

    const r = await projectSessions(usage, root, { since: null, until: at(30) }, env(), runner);
    expect(r.sessions.map((s) => s.id)).toEqual(['s-new']);
    expect(r.sessions[0]!.facts).toEqual({ turns: 3 });
    expect(calls).toHaveLength(1);
    const [ask] = calls;
    expect(ask!.args).toContain('haiku');
    const prompt = ask!.args[1]!;
    expect(prompt).toContain('"cwd": [\n    "absolute path"\n  ]');
    expect(prompt).not.toContain(root); // never the values
    expect(prompt).not.toContain('s-new');
    expect(JSON.parse(await readFile(join(base, 'machine', FIELDS_FILE), 'utf8'))).toEqual({ formats: [fields] });

    // Next time, read without a model.
    await projectSessions(usage, root, { since: null, until: at(30) }, env(), runner);
    expect(calls).toHaveLength(1);
    expect(await readFieldMaps(env())).toEqual([
      { session_id: 'session_id', project_path: 'project_path', start_time: 'start_time' },
      fields,
    ]);
  });

  it('keeps no answer that reads fewer sessions, and says a format it cannot read', async () => {
    const root = join(base, 'work');
    await writeFile(join(usage, 'session-meta', 'x.json'), JSON.stringify({ id: 'x', where: root, when: at(20) }));
    const { runner } = fakeClaude(done(), { session_id: 'nope' });
    const r = await projectSessions(usage, root, { since: null, until: at(30) }, env(), runner);
    expect(r).toEqual({ sessions: [], files: 1, read: 0 });
    await expect(readFile(join(base, 'machine', FIELDS_FILE), 'utf8')).rejects.toThrow();
    // A model that answers nothing usable changes nothing either.
    const garbage: Runner = async () => ({ stdout: 'not json', stderr: '', code: 1, timedOut: false });
    expect((await projectSessions(usage, root, { since: null, until: at(30) }, env(), garbage)).read).toBe(0);
  });

  it('includes the git worktrees of the project, and does without a cache or a writable machine folder', async () => {
    const { execFileSync } = await import('node:child_process');
    const root = join(base, 'repo');
    const wt = join(base, 'repo-feat');
    await mkdir(root, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd: root, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    await writeFile(join(root, 'a.txt'), 'a');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    git('worktree', 'add', '-q', '-b', 'feat', wt);
    await session('s-wt', wt, 20, FACET);
    await session('s-main', root, 21);
    const period = { since: null, until: at(30) };
    expect((await projectSessions(usage, root, period, env())).sessions.map((s) => s.id)).toEqual(['s-wt', 's-main']);
    expect(await projectSessions(join(base, 'nowhere'), root, period, env())).toEqual({
      sessions: [],
      files: 0,
      read: 0,
    });

    // A new format learnt while the machine folder cannot be written: still read this time.
    await writeFile(join(usage, 'session-meta', 's-new.json'), JSON.stringify({ sid: 's-new', dir: root, at: at(22) }));
    const blocked = { HOME: home, LOCAL_REVIEW_HOME: join(base, 'repo', 'a.txt') };
    const { runner } = fakeClaude(done(), { session_id: 'sid', project_path: 'dir', start_time: 'at' });
    expect((await projectSessions(usage, root, period, blocked, runner)).read).toBe(3);
  });

  it('describes a field by its shapes, never its values', () => {
    expect(shapeOf('2026-09-28T22:31:06.433Z')).toBe('ISO date and time');
    expect(shapeOf('0d533f3a-1c05-4da2-aafe-147e1dc70c38')).toBe('UUID');
    expect(shapeOf('/Users/me/work')).toBe('absolute path');
    expect(shapeOf('hello')).toBe('text');
    expect(shapeOf(3)).toBe('number');
    expect(shapeOf(false)).toBe('boolean');
    expect(shapeOf(null)).toBe('null');
    expect(shapeOf([1])).toBe('list');
    expect(shapeOf({ a: 1 })).toBe('object');
    expect(describeFields([{ a: 1, b: '/x' }, { a: 'two' }])).toEqual({ a: ['number', 'text'], b: ['absolute path'] });
    expect(inFolders('/a/b', ['/a'])).toBe(true);
    expect(inFolders('/a', ['/a/'])).toBe(false);
    expect(inFolders('/ab', ['/a'])).toBe(false);
  });

  it("counts the sessions of a project in Claude Code's own conversations, sub-agents apart", async () => {
    const root = join(base, 'work');
    const projects = join(home, '.claude', 'projects', '-work');
    await mkdir(join(projects, 's1', 'subagents'), { recursive: true });
    const line = (cwd: string, ts: string) => JSON.stringify({ type: 'user', cwd, timestamp: ts });
    await writeFile(join(projects, 's1.jsonl'), `{"type":"mode"}\n${line(root, at(20))}\n`);
    await writeFile(join(projects, 's2.jsonl'), `${line(join(root, 'api'), at(21))}\n`);
    await writeFile(join(projects, 's3.jsonl'), `${line(join(base, 'other'), at(21))}\n`);
    await writeFile(join(projects, 's4.jsonl'), `${line(root, at(1))}\n`);
    await writeFile(join(projects, 's5.jsonl'), 'not json\n');
    await writeFile(join(home, '.claude', 'projects', 'not-a-folder.jsonl'), '');
    await writeFile(join(projects, 's1', 'subagents', 'agent-1.jsonl'), `${line(root, at(20))}\n`);
    const claudeDir = join(home, '.claude');
    expect(await countSessions(claudeDir, root, { since: at(10), until: at(30) }, env())).toBe(2);
    expect(await countSessions(claudeDir, root, { since: null, until: at(30) }, env())).toBe(3);
    expect(await countSessions(join(base, 'none'), root, { since: null, until: at(30) }, env())).toBe(0);
  });

  it('runs /insights in a separate Claude Code, and tells a failure', async () => {
    const { runner, calls } = fakeClaude(done(0.7, 53_000));
    expect(await runInsights(base, env(), runner)).toEqual({ kind: 'done', costUsd: 0.7, durationMs: 53_000 });
    expect(calls[0]!.args).toEqual(['-p', '/insights', '--output-format', 'json']);
    expect(
      await runInsights(base, env(), fakeClaude({ stdout: '{"is_error":true,"result":"Not logged in\\nx"}' }).runner),
    ).toEqual({
      kind: 'failed',
      reason: 'Not logged in',
    });
    expect(await runInsights(base, env(), fakeClaude({ timedOut: true }).runner, 60_000)).toEqual({
      kind: 'failed',
      reason: 'it took more than 1 min',
    });
    expect(await runInsights(base, env(), fakeClaude({ stdout: '', stderr: 'boom', code: 2 }).runner)).toEqual({
      kind: 'failed',
      reason: 'Claude Code ended with code 2: boom',
    });
    expect(await runInsights(base, env(), fakeClaude({ stdout: '{}' }).runner)).toEqual({
      kind: 'done',
      costUsd: null,
      durationMs: null,
    });
  });
});

describe('lr-retro sessions and lr-retro insights', () => {
  const anchor = (): Anchor => ({
    path: 'a.txt',
    source: 'worktree',
    ref: null,
    sha: null,
    ...buildAnchorContext('a\nb\n', { startLine: 1, endLine: 1 }),
  });

  async function retro(since: string | null = at(10)) {
    const root = join(base, 'work');
    const t = await new Store(root).createThread(anchor(), { author: 'user', body: 'Use cents', reviewId: null });
    const book = new RetroBook(root);
    const r = await book.start({ root, since, until: at(30), stores: [], threads: [t.id], bytes: 1 });
    return { root, book, id: r.id };
  }

  async function run(args: string[], runner?: Runner) {
    let out = '';
    let err = '';
    const code = await runRetroCli(args, {
      cwd: base,
      env: env(),
      out: (t) => (out += t + '\n'),
      err: (t) => (err += t + '\n'),
      ...(runner ? { run: runner } : {}),
    });
    return { code, out, err };
  }

  it('records the sessions of the retro in its journal, and writes them for its analysis', async () => {
    const { root, book, id } = await retro();
    await session('s-in', root, 20, FACET);
    await session('s-bare', root, 21);
    await session('s-other', join(base, 'other'), 20, FACET);
    const r = await run(['insights', id, '--root', root], fakeClaude(done(0.7, 53_000)).runner);
    expect(r).toMatchObject({ code: 0, err: '' });
    const file = join(root, '.local-review', 'retros', id, 'sessions.json');
    expect(r.out).toBe(
      `Written: ${file}\n2 Claude Code sessions of this project in the period, 1 with a summary by /insights: ` +
        'lr retro input --for analysis includes them.\n',
    );
    const state = await book.get(id);
    expect(state.sessions).toEqual({
      source: 'Claude Code /insights',
      list: [
        { id: 's-in', start: at(20), summary: true },
        { id: 's-bare', start: at(21), summary: false },
      ],
      costUsd: 0.7,
      durationMs: 53_000,
    });
    const written = JSON.parse(await readFile(file, 'utf8'));
    expect(written.sessions.map((s: { id: string }) => s.id)).toEqual(['s-in', 's-bare']);
  });

  it('goes on with the last results when /insights fails, and fails without any', async () => {
    const { root, book, id } = await retro();
    const failed = fakeClaude({ stdout: '{"is_error":true,"result":"Not logged in"}' }).runner;
    const none = await run(['insights', id, '--root', root], failed);
    expect(none).toMatchObject({ code: 1, out: '' });
    expect(none.err).toContain('/insights failed (Not logged in): the retro goes on without the sessions.');

    await session('s-in', root, 20, FACET);
    const last = await run(['insights', id, '--root', root], failed);
    expect(last.code).toBe(0);
    expect(last.out).toContain('(/insights did not run: Not logged in; its last results were used.)');
    expect((await book.get(id)).sessions).toMatchObject({ costUsd: null, durationMs: null });
  });

  it('tells the user to report a format it cannot read', async () => {
    const { root, id } = await retro();
    await writeFile(join(usage, 'session-meta', 'x.json'), JSON.stringify({ unknown: 1 }));
    const r = await run(['insights', id, '--root', root], fakeClaude(done(), {}).runner);
    expect(r.code).toBe(1);
    expect(r.err).toContain('none could be read: its format changed');
    expect(r.err).toContain('report it as a bug of Local Review');
  });

  it('counts the sessions of the next retro', async () => {
    const root = join(base, 'work');
    await mkdir(root, { recursive: true });
    const projects = join(home, '.claude', 'projects', '-work');
    await mkdir(projects, { recursive: true });
    const line = (ts: string) => JSON.stringify({ cwd: root, timestamp: ts });
    await writeFile(join(projects, 's1.jsonl'), `${line(at(20))}\n`);
    await writeFile(join(projects, 's2.jsonl'), `${line(at(2))}\n`);
    expect((await run(['sessions', '--root', root, '--since', '2026-09-10'])).out).toBe(
      '1 Claude Code session in this project since 2026-09-10.\n',
    );
    expect((await run(['sessions', '--root', root, '--all'])).out).toBe(
      '2 Claude Code sessions in this project over the whole history.\n',
    );
    expect((await run(['sessions', '--root', root, '--since', 'soon'])).err).toContain('--since takes a date');
    expect((await run(['sessions', '--root', root, '--since', '7d', '--all'])).err).toContain('not both');
  });
});

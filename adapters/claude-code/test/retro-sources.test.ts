import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAgentSessions, RetroBook, SessionRegistry, type RetroSource } from '@local-review/core';
import { handleHook, type HookDeps } from '../src/hook';
import type { Runner } from '../src/retroAudit';
import { runRetroCli } from '../src/retroCli';
import { projectTranscripts } from '../src/retroInsights';
import { isPrintMode, recordClaudeSession } from '../src/sessionLog';

let base: string;
const env = () => ({ HOME: join(base, 'home'), LOCAL_REVIEW_HOME: join(base, 'machine') });

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'lr-retro-sources-claude-')));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** A conversation kept by Claude Code: its first line holds the folder, the time and how it was run. */
async function transcript(claudeDir: string, id: string, cwd: string, entrypoint: string, timestamp: string) {
  const dir = join(claudeDir, 'projects', cwd.replace(/\//g, '-'));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.jsonl`), JSON.stringify({ type: 'user', cwd, entrypoint, timestamp }) + '\n');
}

describe('the log of Claude Code sessions, for the cadence of retros', () => {
  it('records the sessions Claude Code keeps once, without those run by a program, then each new one', async () => {
    const claude = join(base, 'claude');
    await transcript(claude, 'old', '/work', 'cli', '2026-09-20T10:00:00.000Z');
    await transcript(claude, 'script', '/work', 'sdk-cli', '2026-09-21T10:00:00.000Z');
    await recordClaudeSession({ id: 'now', cwd: '/work', startedAt: '2026-10-03T12:00:00.000Z' }, claude, env());
    // Imported once: a conversation found later is not read again (the hook records each new session).
    await transcript(claude, 'missed', '/work', 'cli', '2026-09-22T10:00:00.000Z');
    await recordClaudeSession({ id: 'now', cwd: '/work', startedAt: '2026-10-03T13:00:00.000Z' }, claude, env());
    await recordClaudeSession({ id: 'next', cwd: '/work', startedAt: '2026-10-03T14:00:00.000Z' }, claude, env());
    const log = await readAgentSessions(env());
    expect(log.imported).toEqual(new Set([claude]));
    expect(log.sessions.map((x) => `${x.id} ${x.startedAt}`).sort()).toEqual([
      'next 2026-10-03T14:00:00.000Z',
      'now 2026-10-03T12:00:00.000Z',
      'old 2026-09-20T10:00:00.000Z',
    ]);
  });

  it('tells a session run by a program from its command line', () => {
    expect(isPrintMode('claude -p "hello"')).toBe(true);
    expect(isPrintMode('/usr/bin/claude --print --model haiku')).toBe(true);
    expect(isPrintMode('claude --plugin-dir x')).toBe(false);
  });

  it('is fed by the hook at the start of each session, not of a session run by a program', async () => {
    const recorded: string[] = [];
    const deps: HookDeps = {
      registry: new SessionRegistry(join(base, 'machine'), () => true),
      claudePid: async () => 4242,
      commandLine: async () => 'claude',
      gitBranch: async () => null,
      topicOf: async (path) => ({ kind: 'path', path }),
      gitWorktreeOf: async () => null,
      filesChangedSince: async () => [],
      now: () => new Date('2026-10-03T12:00:00.000Z'),
      recordSession: async (s) => void recorded.push(`${s.id} ${s.cwd} ${s.startedAt}`),
    };
    await handleHook({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/work' }, deps);
    deps.commandLine = async () => 'claude -p hi';
    await handleHook({ hook_event_name: 'SessionStart', session_id: 's2', cwd: '/work' }, deps);
    expect(recorded).toEqual(['s1 /work 2026-10-03T12:00:00.000Z']);
    // A failure, or a slow import, never holds the session up.
    deps.commandLine = async () => 'claude';
    deps.recordSession = async () => {
      throw new Error('disk full');
    };
    await handleHook({ hook_event_name: 'SessionStart', session_id: 's3', cwd: '/work' }, deps);
    deps.recordSession = () => new Promise(() => undefined);
    deps.reminderTimeoutMs = 20;
    await handleHook({ hook_event_name: 'SessionStart', session_id: 's4', cwd: '/work' }, deps);
  });
});

describe('lr-retro, on the sources of the retro', () => {
  async function retro(sources: RetroSource[]) {
    const root = join(base, 'work');
    const book = new RetroBook(root);
    const r = await book.start({
      root,
      since: null,
      until: new Date().toISOString(),
      stores: [],
      threads: [],
      bytes: 0,
      sources,
    });
    return { root, id: r.id };
  }
  async function run(args: string[]) {
    let out = '';
    let err = '';
    const ran: string[] = [];
    const runner: Runner = async (_cmd, a) => {
      ran.push(a.join(' '));
      return { stdout: '', stderr: '', code: 1, timedOut: false };
    };
    const code = await runRetroCli(args, {
      cwd: base,
      env: env(),
      out: (t) => (out += t + '\n'),
      err: (t) => (err += t + '\n'),
      run: runner,
      session: async () => undefined,
    });
    return { code, out, err, ran };
  }

  it('skips what reads a source the retro leaves out', async () => {
    const { root, id } = await retro(['reviews']);
    for (const action of ['audit', 'usage', 'reports', 'insights']) {
      const r = await run([action, id, '--root', root]);
      expect(r).toMatchObject({ code: 0, ran: [] });
      expect(r.out).toMatch(
        new RegExp(
          `^Skipped: retro ${id} does not read the (audit of the setup|Claude Code sessions) \\(its sources: reviews\\)\\.`,
        ),
      );
    }
    const other = await retro(['sessions']);
    const jev = await run(['jev', other.id, '--root', other.root]);
    expect(jev.code).toBe(1);
    expect(jev.err).toContain('does not read the review threads: nothing to classify');
  });
});

describe('the sessions a retro looks back at', () => {
  it('leave out those run by a program, such as the audit and /insights of the retro', async () => {
    const claude = join(base, 'claude');
    const root = join(base, 'work');
    await mkdir(root, { recursive: true });
    await transcript(claude, 'mine', root, 'cli', '2026-10-01T10:00:00.000Z');
    await transcript(claude, 'audit', root, 'sdk-cli', '2026-10-01T11:00:00.000Z');
    const period = { since: null, until: '2026-10-09T00:00:00.000Z' };
    expect((await projectTranscripts(claude, root, period, env())).map((t) => t.id)).toEqual(['mine']);

    // Through /insights too: its facts do not say how a session was run, its conversation does.
    for (const id of ['mine', 'audit']) {
      await mkdir(join(claude, 'usage-data', 'session-meta'), { recursive: true });
      await writeFile(
        join(claude, 'usage-data', 'session-meta', `${id}.json`),
        JSON.stringify({ session_id: id, project_path: root, start_time: '2026-10-01T10:00:00.000Z' }),
      );
    }
    const r = await new RetroBook(root).start({
      ...period,
      root,
      stores: [],
      threads: [],
      bytes: 0,
      sessionsMode: 'insights',
    });
    const run = await runRetroCli(['insights', r.id, '--root', root], {
      cwd: base,
      env: { ...env(), CLAUDE_CONFIG_DIR: claude },
      out: () => undefined,
      err: () => undefined,
      run: async () => ({ stdout: JSON.stringify({ result: 'ok' }), stderr: '', code: 0, timedOut: false }),
      session: async () => undefined,
    });
    expect(run).toBe(0);
    expect((await new RetroBook(root).get(r.id)).sessions?.list.map((x) => x.id)).toEqual(['mine']);
  });
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionRegistry } from '@local-review/core';
import { LAUNCH_WITH_CHANNEL } from '../src/channelFlag';
import { changedFiles, findClaudePid, handleHook, type HookDeps } from '../src/hook';

let home: string;
let registry: SessionRegistry;
let deps: HookDeps;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'lr-hook-'));
  registry = new SessionRegistry(home, () => true);
  deps = {
    registry,
    claudePid: async () => 4242,
    commandLine: async () => 'claude',
    gitBranch: async () => 'feature-x',
    changedFiles: async () => [],
    now: () => new Date('2026-09-26T10:00:00.000Z'),
  };
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('Claude Code hooks', () => {
  it('registers the session on SessionStart', async () => {
    await handleHook({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/repo' }, deps);
    expect(await registry.list()).toEqual([
      {
        id: 's1',
        agent: 'Claude',
        cwd: '/repo',
        workingDir: null,
        branch: 'feature-x',
        pid: 4242,
        startedAt: '2026-09-26T10:00:00.000Z',
        push: false,
        pushCommand: LAUNCH_WITH_CHANNEL,
        touched: [],
        writtenAt: {},
      },
    ]);
  });

  it('records whether the session was launched with the channel', async () => {
    deps.commandLine = async () => LAUNCH_WITH_CHANNEL;
    await handleHook({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/repo' }, deps);
    expect(await registry.list()).toMatchObject([{ push: true, pushCommand: null }]);
    deps.claudePid = async () => null; // unknown process: unknown
    await handleHook({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/repo' }, deps);
    expect(await registry.list()).toMatchObject([{ push: null }]);
  });

  it('records the files Claude writes, and only those', async () => {
    await handleHook({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/repo' }, deps);
    const post = (tool_name: string, tool_input: object) =>
      handleHook({ hook_event_name: 'PostToolUse', session_id: 's1', cwd: '/repo', tool_name, tool_input }, deps);
    await post('Write', { file_path: '/specs/plan.md' });
    await post('Edit', { file_path: 'src/a.ts' }); // relative: resolved against the session folder
    await post('NotebookEdit', { notebook_path: '/repo/nb.ipynb' });
    await post('Read', { file_path: '/repo/ignored.ts' });
    expect((await registry.list())[0]!.touched).toEqual(['/specs/plan.md', '/repo/src/a.ts', '/repo/nb.ipynb']);
  });

  it('follows the session when it changes folder', async () => {
    await handleHook({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/work' }, deps);
    deps.gitBranch = async (dir) => (dir === '/work/wt-test' ? 'feature-w' : null);
    await handleHook(
      { hook_event_name: 'CwdChanged', session_id: 's1', cwd: '/work/wt-test', new_cwd: '/work/wt-test' },
      deps,
    );
    expect(await registry.list()).toMatchObject([{ cwd: '/work', workingDir: '/work/wt-test', branch: 'feature-w' }]);
  });

  it('follows where Claude works from the cwd of each tool call', async () => {
    await handleHook({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/work' }, deps);
    const post = { hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Bash', tool_use_id: 'toolu_1' };
    await handleHook({ ...post, cwd: '/work/wt-test' }, deps);
    expect(await registry.list()).toMatchObject([{ workingDir: '/work/wt-test' }]);
  });

  it('records the files a shell command changed', async () => {
    await handleHook({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/repo' }, deps);
    const seen: [string, number][] = [];
    deps.changedFiles = async (cwd, since) => (seen.push([cwd, since]), ['/repo/a.py']);
    const call = { session_id: 's1', cwd: '/repo', tool_name: 'Bash', tool_use_id: 'toolu_2' };
    await handleHook({ ...call, hook_event_name: 'PostToolUse' }, deps); // no start noted: nothing
    await handleHook({ ...call, hook_event_name: 'PreToolUse' }, deps);
    await handleHook({ ...call, hook_event_name: 'PostToolUse' }, deps);
    expect(seen).toEqual([['/repo', new Date('2026-09-26T10:00:00.000Z').getTime()]]);
    expect((await registry.list())[0]!.touched).toEqual(['/repo/a.py']);
  });

  it('unregisters the session on SessionEnd', async () => {
    await handleHook({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/repo' }, deps);
    await handleHook({ hook_event_name: 'SessionEnd', session_id: 's1' }, deps);
    expect(await registry.list()).toEqual([]);
  });

  it('ignores other events and input without a session', async () => {
    await handleHook({ hook_event_name: 'Stop', session_id: 's1' }, deps);
    await handleHook({ hook_event_name: 'SessionStart' }, deps);
    expect(await registry.list()).toEqual([]);
  });

  it('finds no claude process above a test runner', async () => {
    // The test runs under node/vitest, not claude: the walk ends without a match.
    expect(await findClaudePid(process.pid, 3)).toBeNull();
  });
});

describe('changedFiles', () => {
  it('lists the files of the repository changed since a time, and nothing outside git', async () => {
    const { execFileSync } = await import('node:child_process');
    const { writeFile, utimes } = await import('node:fs/promises');
    const repo = await mkdtemp(join(tmpdir(), 'lr-git-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo });
      await writeFile(join(repo, 'old.txt'), 'old');
      await writeFile(join(repo, 'new.txt'), 'new');
      const past = new Date(Date.now() - 60_000);
      await utimes(join(repo, 'old.txt'), past, past);
      const since = Date.now() - 10_000;
      const real = (p: string) => execFileSync('realpath', [p], { encoding: 'utf8' }).trim();
      expect(await changedFiles(repo, since)).toEqual([join(real(repo), 'new.txt')]);
      expect(await changedFiles(tmpdir(), since)).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

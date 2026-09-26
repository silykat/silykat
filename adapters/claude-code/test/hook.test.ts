import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionRegistry } from '@local-review/core';
import { LAUNCH_WITH_CHANNEL } from '../src/channelFlag';
import { findClaudePid, handleHook, type HookDeps } from '../src/hook';

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

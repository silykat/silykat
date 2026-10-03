import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionRegistry, type WorktreeInfo, type WorktreeSave } from '@local-review/core';
import { handleHook, shellSegments, worktreeRemovals, type HookDeps, type HookInput } from '../src/hook';

describe('commands that remove a git worktree', () => {
  const at = (command: string, cwd = '/work/app') =>
    worktreeRemovals(command, cwd, '/home/me').map((r) => `${r.kind} ${r.spec} @ ${r.cwd}`);

  it('finds git worktree remove, wherever it is run from', () => {
    expect(at('git worktree remove ../wt')).toEqual(['git ../wt @ /work/app']);
    expect(at('git worktree remove --force -f "../my wt"')).toEqual(['git ../my wt @ /work/app']);
    expect(at('cd /work && git -C app worktree remove wt')).toEqual(['git wt @ /work/app']);
    expect(at('git -c core.x=1 --no-pager worktree remove -- -odd')).toEqual(['git -odd @ /work/app']);
    expect(at('cd ~/code; GIT_X=1 git worktree remove ~/wt')).toEqual(['git /home/me/wt @ /home/me/code']);
    expect(at('cd && git worktree remove x')).toEqual(['git x @ /home/me']);
    expect(at('git worktree list && git worktree prune')).toEqual([]);
    expect(at('git worktree remove')).toEqual([]);
    expect(at('echo "git worktree remove ../wt"')).toEqual([]);
  });

  it('finds rm -r on a folder, but not plain rm nor globs', () => {
    expect(at('rm -rf ../wt')).toEqual(['rm ../wt @ /work/app']);
    expect(at('sudo rm --recursive ../a ../b')).toEqual(['rm ../a @ /work/app', 'rm ../b @ /work/app']);
    expect(at('rm -R ../wt*')).toEqual([]);
    expect(at('rm file.txt')).toEqual([]);
  });

  it('splits a shell line into simple commands, with quotes and escapes', () => {
    expect(shellSegments(`a 'b c' "d \\" e" f\\ g | h; i && j || k & l\nm (n) \\\nnext`)).toEqual([
      ['a', 'b c', 'd " e', 'f g'],
      ['h'],
      ['i'],
      ['j'],
      ['k'],
      ['l'],
      ['m'],
      ['n'],
      ['next'],
    ]);
    expect(shellSegments(`echo 'unclosed`)).toEqual([['echo', 'unclosed']]);
    expect(shellSegments('')).toEqual([]);
  });
});

describe('the hook, before a worktree is removed', () => {
  let home: string;
  let deps: HookDeps;
  let saved: string[];
  let keepHistory: boolean;
  const LINKED: WorktreeInfo = {
    worktree: '/work/wt',
    repo: '/work/app/.git',
    linked: true,
    main: '/work/app',
    branch: 'feat',
  };
  const infos: Record<string, WorktreeInfo> = {
    '/work/wt': LINKED,
    '/work/wt/src': LINKED,
    '/work/app': { ...LINKED, worktree: '/work/app', linked: false, branch: 'main' },
  };
  const result = (published: number): WorktreeSave => ({
    worktree: '/work/wt',
    branch: 'feat',
    main: '/work/app',
    copies: [],
    threads: published,
    published,
  });
  let published = 2;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'lr-hook-wt-'));
    saved = [];
    keepHistory = true;
    published = 2;
    deps = {
      registry: new SessionRegistry(home, () => true),
      claudePid: async () => null,
      commandLine: async () => null,
      gitBranch: async () => null,
      topicOf: async (path) => ({ kind: 'path', path }),
      gitWorktreeOf: async () => null,
      filesChangedSince: async () => [],
      now: () => new Date('2026-10-03T10:00:00.000Z'),
      home: '/home/me',
      worktrees: {
        keepHistory: async () => keepHistory,
        resolveWorktree: async (cwd, spec) => (spec === 'wt' || spec === '../wt' ? '/work/wt' : null),
        worktreeInfo: async (dir) => infos[dir] ?? null,
        save: async (dir) => {
          saved.push(dir);
          return result(published);
        },
        threadCount: async () => 3,
      },
    };
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const pre = (tool_input: HookInput['tool_input'], tool_name = 'Bash', cwd = '/work/app') =>
    handleHook(
      { hook_event_name: 'PreToolUse', session_id: 's1', cwd, tool_name, tool_use_id: 'toolu_1', tool_input },
      deps,
    );

  it('saves its threads first, and tells Claude to tell the user', async () => {
    const message = await pre({ command: 'git worktree remove ../wt' });
    expect(saved).toEqual(['/work/wt']);
    expect(message).toContain(
      'before this command removes the git worktree /work/wt (branch feat), its comment threads (2) were saved',
    );
    expect(message).toContain('Tell the user in one short sentence.');
  });

  it('says nothing when the worktree had no comment, and saves each worktree once', async () => {
    published = 0;
    expect(await pre({ command: 'git worktree remove ../wt && rm -rf ../wt' })).toBeUndefined();
    expect(saved).toEqual(['/work/wt']);
  });

  it('only acts on linked worktrees, and on rm -r of the worktree itself', async () => {
    expect(await pre({ command: 'git worktree remove ../nope' })).toBeUndefined();
    expect(await pre({ command: 'rm -rf .' })).toBeUndefined(); // the main worktree
    expect(await pre({ command: 'rm -rf ../wt/src' })).toBeUndefined(); // a folder of the worktree
    expect(await pre({ command: 'ls' })).toBeUndefined();
    expect(await pre({ command: 42 })).toBeUndefined();
    expect(saved).toEqual([]);
  });

  it('warns Claude instead when the history is not kept', async () => {
    keepHistory = false;
    const message = await pre({ command: 'git worktree remove wt' });
    expect(saved).toEqual([]);
    expect(message).toContain('which holds 3 comment threads of the user');
    expect(message).toContain('the history is not kept on this machine: keep-history is off');
    expect(message).toContain('lr worktree save /work/wt');
  });

  it('tells Claude when the threads could not be saved', async () => {
    deps.worktrees!.save = async () => {
      throw new Error('disk full');
    };
    const message = await pre({ command: 'git worktree remove ../wt' });
    expect(message).toContain('its comment threads could not be saved first (disk full)');
    expect(message).toContain('Tell the user before going on.');
  });

  it("saves Claude Code's own worktree when the session leaves it with remove", async () => {
    expect(await pre({ action: 'keep' }, 'ExitWorktree', '/work/wt')).toBeUndefined();
    expect(await pre({ action: 'remove' }, 'ExitWorktree', '/work/wt/src')).toContain('its comment threads (2)');
    expect(saved).toEqual(['/work/wt']);
  });

  it('does nothing without the worktree helpers or a folder', async () => {
    expect(
      await handleHook(
        {
          hook_event_name: 'PreToolUse',
          session_id: 's1',
          tool_name: 'Bash',
          tool_input: { command: 'git worktree remove ../wt' },
        },
        deps,
      ),
    ).toBeUndefined();
    delete deps.worktrees;
    expect(await pre({ command: 'git worktree remove ../wt' })).toBeUndefined();
  });
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CADENCE, SessionRegistry, topicLabel, type RetroCadence } from '@local-review/core';
import { LAUNCH_WITH_CHANNEL } from '../src/channelFlag';
import { findClaudePid, handleHook, runsClaude, type HookDeps } from '../src/hook';

let home: string;
let registry: SessionRegistry;
let deps: HookDeps;

/** A fake file system: worktrees by folder, everything else is outside git. */
const WORKTREES: Record<string, string> = { '/work/app': 'main', '/work/wt-feat': 'feat' };
const worktreeOf = async (dir: string) => {
  const top = Object.keys(WORKTREES).find((w) => dir === w || dir.startsWith(`${w}/`));
  return top ? { repo: '/work/app/.git', branch: WORKTREES[top]!, worktree: top } : null;
};
const subs = async (id = 's1') => (await registry.subscriptions(id)).map((s) => `${topicLabel(s.topic)} (${s.reason})`);

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'lr-hook-'));
  registry = new SessionRegistry(home, () => true);
  deps = {
    registry,
    claudePid: async () => 4242,
    commandLine: async () => 'claude',
    gitBranch: async () => null,
    topicOf: async (path) => {
      const wt = await worktreeOf(path);
      return wt ? { kind: 'branch', ...wt } : { kind: 'path', path };
    },
    gitWorktreeOf: worktreeOf,
    filesChangedSince: async () => [],
    now: () => new Date('2026-09-26T10:00:00.000Z'),
  };
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const start = (cwd: string) => handleHook({ hook_event_name: 'SessionStart', session_id: 's1', cwd }, deps);

describe('Claude Code hooks', () => {
  it('registers the session on SessionStart', async () => {
    deps.gitBranch = async () => 'feature-x';
    expect(await start('/work')).toBeUndefined(); // outside git: nothing to subscribe to
    expect(await registry.list()).toEqual([
      {
        id: 's1',
        agent: 'Claude',
        cwd: '/work',
        branch: 'feature-x',
        pid: 4242,
        startedAt: '2026-09-26T10:00:00.000Z',
        push: false,
        pushCommand: LAUNCH_WITH_CHANNEL,
        subscriptions: [],
      },
    ]);
  });

  it('subscribes a session started in a worktree to its branch, and tells Claude', async () => {
    const message = await start('/work/wt-feat/src');
    expect(message).toContain('now subscribed to app · feat (you were started in its worktree)');
    expect(await subs()).toEqual(['app · feat (launch)']);
  });

  it('records whether the session was launched with the channel', async () => {
    deps.commandLine = async () => LAUNCH_WITH_CHANNEL;
    await start('/work');
    expect(await registry.list()).toMatchObject([{ push: true, pushCommand: null }]);
    deps.claudePid = async () => null; // unknown process: unknown
    await start('/work');
    expect(await registry.list()).toMatchObject([{ push: null }]);
  });

  it('subscribes to the branch of a file Claude writes, once, and tells Claude the first time', async () => {
    await start('/work');
    const write = (file_path: string, tool_name = 'Edit') =>
      handleHook(
        { hook_event_name: 'PostToolUse', session_id: 's1', cwd: '/work', tool_name, tool_input: { file_path } },
        deps,
      );
    expect(await write('/work/wt-feat/a.ts')).toContain('now subscribed to app · feat (you modified a file there)');
    expect(await write('wt-feat/b.ts', 'Write')).toBeUndefined(); // relative to the cwd; already subscribed
    expect(await write('/specs/plan.md')).toContain('now subscribed to /specs/plan.md'); // outside git: the file
    expect(
      await handleHook(
        {
          hook_event_name: 'PostToolUse',
          session_id: 's1',
          tool_name: 'Read',
          tool_input: { file_path: '/work/app/x.ts' },
        },
        deps,
      ),
    ).toBeUndefined();
    expect(await subs()).toEqual(['app · feat (modified)', '/specs/plan.md (modified)']);
  });

  it('subscribes to the branch where a shell command changed files', async () => {
    await start('/work');
    const seen: [string, number][] = [];
    deps.filesChangedSince = async (cwd, since) => (seen.push([cwd, since]), ['/work/app/a.py']);
    const call = { session_id: 's1', cwd: '/work/app', tool_name: 'Bash', tool_use_id: 'toolu_2' };
    expect(await handleHook({ ...call, hook_event_name: 'PostToolUse' }, deps)).toBeUndefined(); // no start noted
    await handleHook({ ...call, hook_event_name: 'PreToolUse' }, deps);
    expect(await handleHook({ ...call, hook_event_name: 'PostToolUse' }, deps)).toContain('app · main');
    expect(seen).toEqual([['/work/app', new Date('2026-09-26T10:00:00.000Z').getTime()]]);
    expect(await subs()).toEqual(['app · main (modified)']);

    // Already subscribed there: nothing more to look at.
    await handleHook({ ...call, hook_event_name: 'PreToolUse' }, deps);
    await handleHook({ ...call, hook_event_name: 'PostToolUse' }, deps);
    expect(seen).toHaveLength(1);
  });

  it('does not subscribe when a shell command changed nothing, or ran outside git', async () => {
    await start('/work');
    for (const cwd of ['/work/app', '/tmp']) {
      const call = { session_id: 's1', cwd, tool_name: 'Bash', tool_use_id: 'toolu_3' };
      await handleHook({ ...call, hook_event_name: 'PreToolUse' }, deps);
      await handleHook({ ...call, hook_event_name: 'PostToolUse' }, deps);
    }
    expect(await subs()).toEqual([]);
  });

  it('unregisters the session, and its subscriptions, on SessionEnd', async () => {
    await start('/work/app');
    await handleHook({ hook_event_name: 'SessionEnd', session_id: 's1' }, deps);
    expect(await registry.list()).toEqual([]);
    expect(await registry.subscriptions('s1')).toEqual([]);
  });

  it('ignores other events and input without a session', async () => {
    await handleHook({ hook_event_name: 'Stop', session_id: 's1' }, deps);
    await handleHook({ hook_event_name: 'SessionStart' }, deps);
    expect(await registry.list()).toEqual([]);
  });
});

describe('the retro reminder at the start of a session', () => {
  const due: RetroCadence = {
    root: '/work',
    lastRetro: { id: 'rt_1', root: '/work', until: '2026-09-18T10:00:00.000Z' },
    since: '2026-09-18T10:00:00.000Z',
    days: 8,
    threads: 45,
    bytes: 1_200_000,
    sessions: 0,
    thresholds: DEFAULT_CADENCE,
    due: true,
    reasons: ['days', 'size'],
  };
  const startAs = (source: string | undefined, cwd = '/work') =>
    handleHook({ hook_event_name: 'SessionStart', session_id: 's1', cwd, ...(source ? { source } : {}) }, deps);

  it('asks Claude to tell the user once, in a new conversation', async () => {
    const asked: string[] = [];
    deps.retroCadence = async (cwd) => (asked.push(cwd), due);
    const message = await startAs('startup');
    expect(message).toBe(
      'Local Review: a retro is due for this project (/work): 8 days, 1.2 MB of review threads (45) and 0 agent sessions since the last retro (2026-09-18);' +
        ' 8 days since the last retro (reminder at 7); 1.2 MB of threads to look back at (reminder at 1.0 MB).' +
        ' In your first reply of this session, tell the user so in one short sentence and suggest `/local-review:retro`' +
        ' (a retro looks back at their review feedback and their sessions with you, to improve your setup with them).' +
        ' Say it once only, and do not start the retro unless they ask.',
    );
    expect(await startAs(undefined)).toContain('a retro is due');
    expect(await startAs('clear')).toContain('a retro is due');
    expect(asked).toEqual(['/work', '/work', '/work']);
    // A resumed or compacted conversation already had it.
    expect(await startAs('resume')).toBeUndefined();
    expect(await startAs('compact')).toBeUndefined();
    expect(asked).toHaveLength(3);
  });

  it('says it after the subscription of a worktree session', async () => {
    deps.retroCadence = async () => due;
    const message = await startAs('startup', '/work/wt-feat');
    expect(message).toMatch(/now subscribed to app · feat .*\n\nLocal Review: a retro is due/s);
  });

  it('says nothing when no retro is due, when it fails, or when it takes too long', async () => {
    deps.retroCadence = async () => ({ ...due, due: false, reasons: [] });
    expect(await startAs('startup')).toBeUndefined();
    deps.retroCadence = async () => null; // reminder off
    expect(await startAs('startup')).toBeUndefined();
    deps.retroCadence = async () => {
      throw new Error('unreadable');
    };
    expect(await startAs('startup')).toBeUndefined();
    deps.reminderTimeoutMs = 20;
    deps.retroCadence = () => new Promise((done) => setTimeout(() => done(due), 1000));
    const t0 = Date.now();
    expect(await startAs('startup')).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe('findClaudePid', () => {
  it('returns null when no claude process is found above', async () => {
    expect(await findClaudePid(process.pid, 3)).toBeNull();
  });
});

describe('runsClaude', () => {
  it('recognizes the claude executable, or a claude script run by node', () => {
    expect(runsClaude('claude --dangerously-load-development-channels plugin:local-review@local-review')).toBe(true);
    expect(runsClaude('/home/me/.local/bin/claude')).toBe(true);
    expect(runsClaude('node /usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude -p hi')).toBe(true);
  });

  it('does not take other commands for claude', () => {
    expect(runsClaude('vim CLAUDE.md')).toBe(false);
    expect(runsClaude('node /usr/bin/npm test claude')).toBe(false);
    expect(runsClaude('')).toBe(false);
    expect(runsClaude(null)).toBe(false);
  });
});

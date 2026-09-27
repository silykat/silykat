import { execFile } from 'node:child_process';
import { basename, isAbsolute, resolve } from 'node:path';
import { topicKey, topicLabel, type SessionRegistry, type Topic } from '@local-review/core';
import { hasChannel, LAUNCH_WITH_CHANNEL } from './channelFlag';

// Claude Code hooks → the neutral session registry. Everything here is specific to Claude Code:
// the hook input format, the event names, the tool names and how to find its process.

/** The part of Claude Code's hook input we use (it is sent as JSON on stdin). */
export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: { file_path?: unknown; notebook_path?: unknown };
}

export interface HookDeps {
  registry: Pick<SessionRegistry, 'register' | 'unregister' | 'subscribe' | 'subscriptions' | 'setNote' | 'takeNote'>;
  /** The Claude Code process of this session, to notice when it is gone. */
  claudePid(): Promise<number | null>;
  /** The command line of a process, to know whether Claude Code was launched with the channel. */
  commandLine(pid: number): Promise<string | null>;
  gitBranch(cwd: string): Promise<string | null>;
  topicOf(path: string): Promise<Topic>;
  gitWorktreeOf(dir: string): Promise<{ repo: string; branch: string; worktree: string } | null>;
  filesChangedSince(dir: string, sinceMs: number): Promise<string[]>;
  now(): Date;
}

/** Tools that write files: their target is a file the session modified. */
export const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

/**
 * Handles one hook call. Resolves to a message for Claude (added to its context), e.g. to tell it
 * that the session was just subscribed to a branch, so that it tells the user.
 */
export async function handleHook(input: HookInput, deps: HookDeps): Promise<string | undefined> {
  const id = input.session_id;
  if (!id) return undefined;
  switch (input.hook_event_name) {
    case 'SessionStart': {
      const cwd = input.cwd ?? process.cwd();
      const pid = await deps.claudePid();
      const commandLine = pid === null ? null : await deps.commandLine(pid);
      const push = commandLine === null ? null : hasChannel(commandLine);
      await deps.registry.register({
        id,
        agent: 'Claude',
        cwd,
        branch: await deps.gitBranch(cwd),
        pid,
        startedAt: deps.now().toISOString(),
        push,
        pushCommand: push === true ? null : LAUNCH_WITH_CHANNEL,
      });
      // Started in a git worktree: the session works on its branch.
      const wt = await deps.gitWorktreeOf(cwd);
      if (!wt) return undefined;
      const topic: Topic = { kind: 'branch', ...wt };
      return (await deps.registry.subscribe(id, topic, 'launch'))
        ? subscribed(topic, 'you were started in its worktree')
        : undefined;
    }
    case 'SessionEnd':
      await deps.registry.unregister(id);
      return undefined;
    case 'PreToolUse':
      // Claude often edits files with shell commands: note when the command starts, to see after
      // it which files it changed.
      if (input.tool_name === 'Bash') await deps.registry.setNote(id, bashNote(input), String(deps.now().getTime()));
      return undefined;
    case 'PostToolUse': {
      if (input.tool_name === 'Bash') return afterShellCommand(id, input, deps);
      if (!WRITE_TOOLS.includes(input.tool_name ?? '')) return undefined;
      const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
      if (typeof target !== 'string' || target === '') return undefined;
      const file = isAbsolute(target) ? target : resolve(input.cwd ?? process.cwd(), target);
      const topic = await deps.topicOf(file);
      return (await deps.registry.subscribe(id, topic, 'modified'))
        ? subscribed(topic, 'you modified a file there')
        : undefined;
    }
  }
  return undefined;
}

/** After a shell command: if it changed files of a branch the session is not subscribed to yet, subscribe. */
async function afterShellCommand(id: string, input: HookInput, deps: HookDeps): Promise<string | undefined> {
  const since = Number(await deps.registry.takeNote(id, bashNote(input)));
  if (!input.cwd || !Number.isFinite(since) || since <= 0) return undefined;
  const wt = await deps.gitWorktreeOf(input.cwd);
  if (!wt) return undefined; // outside git, shell commands are not followed
  const topic: Topic = { kind: 'branch', ...wt };
  const already = (await deps.registry.subscriptions(id)).some((s) => topicKey(s.topic) === topicKey(topic));
  if (already || (await deps.filesChangedSince(input.cwd, since)).length === 0) return undefined;
  return (await deps.registry.subscribe(id, topic, 'modified'))
    ? subscribed(topic, 'you modified files there')
    : undefined;
}

const subscribed = (topic: Topic, why: string) =>
  `Local Review: this session is now subscribed to ${topicLabel(topic)} (${why}): the comments the user publishes ` +
  'there will come to you. Tell the user in one short sentence.';

/** One note per shell command, as several may run at once. */
const bashNote = (input: HookInput) =>
  `bash-${/^[A-Za-z0-9_-]{1,100}$/.test(input.tool_use_id ?? '') ? input.tool_use_id : 'command'}`;

function run(cmd: string, args: string[], cwd?: string): Promise<string | null> {
  return new Promise((done) =>
    execFile(cmd, args, { cwd, timeout: 3000 }, (err, stdout) => done(err ? null : stdout.trim())),
  );
}

/** Current branch; also works in a repository without any commit yet. `null` when detached. */
export const gitBranch = async (cwd: string): Promise<string | null> =>
  (await run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd)) || null;

export const commandLine = (pid: number): Promise<string | null> => run('ps', ['-o', 'args=', '-p', String(pid)]);

/**
 * Walks up from this hook's process to the `claude` process that runs the session (the hook may
 * run through a shell). `null` if it cannot be found, e.g. on a platform without `ps`.
 */
export async function findClaudePid(startPid: number = process.ppid, maxHops = 6): Promise<number | null> {
  let pid = startPid;
  for (let hop = 0; hop < maxHops && pid > 1; hop++) {
    const line = await run('ps', ['-o', 'ppid=,comm=', '-p', String(pid)]);
    if (!line) return null;
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) return null;
    if (basename(match[2]!.trim()) === 'claude') return pid;
    pid = Number(match[1]);
  }
  return null;
}

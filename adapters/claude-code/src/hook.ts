import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { SessionRegistry } from '@local-review/core';
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
  /** CwdChanged: where Claude works now. */
  new_cwd?: string;
}

export interface HookDeps {
  registry: Pick<SessionRegistry, 'register' | 'unregister' | 'touch' | 'moveTo' | 'setNote' | 'takeNote'>;
  /** The Claude Code process of this session, to notice when it is gone. */
  claudePid(): Promise<number | null>;
  /** The command line of a process, to know whether Claude Code was launched with the channel. */
  commandLine(pid: number): Promise<string | null>;
  gitBranch(cwd: string): Promise<string | null>;
  /** Files of the git repository of `cwd` changed since `sinceMs` (absolute paths). */
  changedFiles(cwd: string, sinceMs: number): Promise<string[]>;
  now(): Date;
}

/** Tools that write files; their target is where "the session wrote this file" comes from. */
export const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

export async function handleHook(input: HookInput, deps: HookDeps): Promise<void> {
  const id = input.session_id;
  if (!id) return;
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
      return;
    }
    case 'SessionEnd':
      await deps.registry.unregister(id);
      return;
    case 'CwdChanged': {
      // Where the session works now (e.g. after `cd` into a worktree): comments there are for it.
      const dir = input.new_cwd ?? input.cwd;
      if (dir) await deps.registry.moveTo(id, dir, await deps.gitBranch(dir));
      return;
    }
    case 'PreToolUse': {
      // Claude often edits files with shell commands: note when the command starts, to see after
      // it which files it changed.
      if (input.tool_name === 'Bash') await deps.registry.setNote(id, bashNote(input), String(deps.now().getTime()));
      return;
    }
    case 'PostToolUse': {
      // Where Claude works now: `cwd` follows its `cd`s (e.g. into a worktree).
      if (input.cwd) await deps.registry.moveTo(id, input.cwd, deps.gitBranch);
      if (input.tool_name === 'Bash') {
        const since = Number(await deps.registry.takeNote(id, bashNote(input)));
        if (!input.cwd || !Number.isFinite(since) || since <= 0) return;
        for (const file of await deps.changedFiles(input.cwd, since)) await deps.registry.touch(id, file);
        return;
      }
      if (!WRITE_TOOLS.includes(input.tool_name ?? '')) return;
      const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
      if (typeof target !== 'string' || target === '') return;
      await deps.registry.touch(id, isAbsolute(target) ? target : resolve(input.cwd ?? process.cwd(), target));
      return;
    }
  }
}

/** One note per shell command, as several may run at once. */
const bashNote = (input: HookInput) =>
  `bash-${/^[A-Za-z0-9_-]{1,100}$/.test(input.tool_use_id ?? '') ? input.tool_use_id : 'command'}`;

function run(cmd: string, args: string[], cwd?: string, raw = false): Promise<string | null> {
  return new Promise((done) =>
    execFile(cmd, args, { cwd, timeout: 3000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
      done(err ? null : raw ? stdout : stdout.trim()),
    ),
  );
}

/**
 * Files git sees as changed or new in the repository of `cwd` whose content changed since
 * `sinceMs` (a second of slack for coarse file times). Nothing outside a git repository.
 */
export async function changedFiles(cwd: string, sinceMs: number): Promise<string[]> {
  const top = await run('git', ['rev-parse', '--show-toplevel'], cwd);
  const status = top ? await run('git', ['status', '--porcelain', '-z'], cwd, true) : null;
  if (!top || !status) return [];
  const paths = status
    .split('\0')
    .filter((entry) => entry.length > 3 && entry[0] !== 'R' && entry[1] !== 'D')
    .map((entry) => join(top, entry.slice(3)));
  const recent = await Promise.all(
    paths.map(async (p) => ((await stat(p).catch(() => null))?.mtimeMs ?? 0) >= sinceMs - 1000),
  );
  return paths.filter((_, i) => recent[i]);
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

import { execFile } from 'node:child_process';
import { basename, isAbsolute, resolve } from 'node:path';
import type { SessionRegistry } from '@local-review/core';

// Claude Code hooks → the neutral session registry. Everything here is specific to Claude Code:
// the hook input format, the event names, the tool names and how to find its process.

/** The part of Claude Code's hook input we use (it is sent as JSON on stdin). */
export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: { file_path?: unknown; notebook_path?: unknown };
}

export interface HookDeps {
  registry: Pick<SessionRegistry, 'register' | 'unregister' | 'touch'>;
  /** The Claude Code process of this session, to notice when it is gone. */
  claudePid(): Promise<number | null>;
  gitBranch(cwd: string): Promise<string | null>;
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
      await deps.registry.register({
        id,
        agent: 'Claude',
        cwd,
        branch: await deps.gitBranch(cwd),
        pid: await deps.claudePid(),
        startedAt: deps.now().toISOString(),
      });
      return;
    }
    case 'SessionEnd':
      await deps.registry.unregister(id);
      return;
    case 'PostToolUse': {
      if (!WRITE_TOOLS.includes(input.tool_name ?? '')) return;
      const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
      if (typeof target !== 'string' || target === '') return;
      await deps.registry.touch(id, isAbsolute(target) ? target : resolve(input.cwd ?? process.cwd(), target));
      return;
    }
  }
}

function run(cmd: string, args: string[], cwd?: string): Promise<string | null> {
  return new Promise((done) =>
    execFile(cmd, args, { cwd, timeout: 3000 }, (err, stdout) => done(err ? null : stdout.trim())),
  );
}

/** Current branch; also works in a repository without any commit yet. `null` when detached. */
export const gitBranch = async (cwd: string): Promise<string | null> =>
  (await run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd)) || null;

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

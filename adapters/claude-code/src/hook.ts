import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import {
  expandHome,
  topicKey,
  topicLabel,
  type SessionRegistry,
  type Topic,
  type WorktreeInfo,
  type WorktreeSave,
} from '@local-review/core';
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
  tool_input?: { file_path?: unknown; notebook_path?: unknown; command?: unknown; action?: unknown };
}

/** What the hook needs to keep the threads of a git worktree an agent is about to remove. */
export interface WorktreeDeps {
  /** The machine setting: save the threads before the removal (on by default). */
  autoSave(): Promise<boolean>;
  /** The worktree a `git worktree remove <spec>` run in `cwd` means, or `null`. */
  resolveWorktree(cwd: string, spec: string): Promise<string | null>;
  worktreeInfo(dir: string): Promise<WorktreeInfo | null>;
  save(dir: string): Promise<WorktreeSave>;
  /** Threads with published comments in the worktree. */
  threadCount(dir: string): Promise<number>;
}

export interface HookDeps {
  registry: Pick<
    SessionRegistry,
    'register' | 'unregister' | 'subscribe' | 'subscriptions' | 'setNote' | 'takeNote' | 'startCall' | 'endCall'
  >;
  /** The Claude Code process of this session, to notice when it is gone. */
  claudePid(): Promise<number | null>;
  /** The command line of a process, to know whether Claude Code was launched with the channel. */
  commandLine(pid: number): Promise<string | null>;
  gitBranch(cwd: string): Promise<string | null>;
  topicOf(path: string): Promise<Topic>;
  gitWorktreeOf(dir: string): Promise<{ repo: string; branch: string; worktree: string } | null>;
  filesChangedSince(dir: string, sinceMs: number): Promise<string[]>;
  now(): Date;
  worktrees?: WorktreeDeps;
  /** The user's home folder, for `cd ~` in a command. */
  home?: string;
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
    case 'PreToolUse': {
      // Claude often edits files with shell commands: note when the command starts, to see after
      // it which files it changed.
      if (input.tool_name === 'Bash') {
        await deps.registry.setNote(id, bashNote(input), String(deps.now().getTime()));
        await noteReply(id, input, deps);
      }
      return beforeWorktreeRemoval(input, deps);
    }
    case 'PostToolUse': {
      if (input.tool_name === 'Bash') {
        const call = replyCall(input);
        if (call) await deps.registry.endCall(id, call.message);
        return afterShellCommand(id, input, deps);
      }
      if (!WRITE_TOOLS.includes(input.tool_name ?? '')) return undefined;
      const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
      if (typeof target !== 'string' || target === '') return undefined;
      const file = isAbsolute(target) ? target : resolve(input.cwd ?? process.cwd(), target);
      const topic = await deps.topicOf(file);
      return (await deps.registry.subscribe(id, topic, 'modified'))
        ? subscribed(topic, 'you modified a file there')
        : undefined;
    }
    case 'PostToolUseFailure': {
      // A command that failed (e.g. `lr reply` refused) gets this event instead of PostToolUse:
      // forget its notes all the same, or a stale call could be taken for a later reply's.
      if (input.tool_name !== 'Bash') return undefined;
      const call = replyCall(input);
      if (call) await deps.registry.endCall(id, call.message);
      await deps.registry.takeNote(id, bashNote(input));
      return undefined;
    }
  }
  return undefined;
}

/**
 * A shell command running `lr reply`: the tool call is the message of the conversation that writes
 * the reply. `null` for any other command, or a tool call id that cannot name a note.
 */
export function replyCall(input: HookInput): { message: string; command: string } | null {
  const command = input.tool_input?.command;
  const message = input.tool_use_id ?? '';
  if (typeof command !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(message)) return null;
  const replies = shellSegments(command).some((words) => {
    const i = words.findIndex((w) => basename(w) === 'lr');
    return i >= 0 && words[i + 1] === 'reply';
  });
  return replies ? { message, command } : null;
}

/** Before `lr reply` runs: note its tool call, which `lr` records with the reply (for retros). */
async function noteReply(id: string, input: HookInput, deps: HookDeps): Promise<void> {
  const call = replyCall(input);
  if (call) await deps.registry.startCall(id, { ...call, at: deps.now().toISOString() });
}

/**
 * Before a command that removes a git worktree (which deletes its comments with it): save its
 * threads to the main worktree's store, unless the user turned that off (then, tell Claude).
 */
async function beforeWorktreeRemoval(input: HookInput, deps: HookDeps): Promise<string | undefined> {
  const wt = deps.worktrees;
  const cwd = input.cwd;
  if (!wt || !cwd) return undefined;
  const targets: { spec: string; cwd: string; kind: Removal['kind'] }[] = [];
  if (input.tool_name === 'Bash' && typeof input.tool_input?.command === 'string')
    targets.push(...worktreeRemovals(input.tool_input.command, cwd, deps.home));
  // Claude Code's own worktrees: leaving one with "remove" deletes it (the session is in it).
  if (input.tool_name === 'ExitWorktree' && input.tool_input?.action === 'remove')
    targets.push({ spec: '.', cwd, kind: 'session' });
  if (targets.length === 0) return undefined;

  const worktrees = new Map<string, WorktreeInfo>();
  for (const t of targets) {
    const dir = t.kind === 'git' ? await wt.resolveWorktree(t.cwd, t.spec) : resolve(t.cwd, t.spec);
    const info = dir ? await wt.worktreeInfo(dir) : null;
    if (!dir || !info?.linked) continue;
    // `rm -r <dir>` only matters for the worktree itself, not for a folder in it.
    if (t.kind === 'rm' && info.worktree !== (await realDir(dir))) continue;
    worktrees.set(info.worktree, info);
  }
  if (worktrees.size === 0) return undefined;

  const messages: string[] = [];
  const autoSave = await wt.autoSave();
  for (const info of worktrees.values()) {
    const name = info.branch ? `${info.worktree} (branch ${info.branch})` : info.worktree;
    if (autoSave) {
      const saved = await wt.save(info.worktree).catch((err: unknown) => {
        // The removal goes on anyway: say so, rather than lose the comments in silence.
        messages.push(
          `Local Review: this command removes the git worktree ${name}, but its comment threads could not be saved first ` +
            `(${err instanceof Error ? err.message : String(err)}): they may be lost with it. Tell the user before going on.`,
        );
        return null;
      });
      if (saved && saved.published > 0)
        messages.push(
          `Local Review: before this command removes the git worktree ${name}, its comment threads (${saved.published}) ` +
            `were saved to the store of ${saved.main}: the user's review history and retros keep them. Tell the user in one short sentence.`,
        );
    } else {
      const n = await wt.threadCount(info.worktree);
      if (n > 0)
        messages.push(
          `Local Review: this command removes the git worktree ${name}, which holds ${plural(n, 'comment thread')} of the user's review, ` +
            'and they are lost with it (saving them first is turned off on this machine). Tell the user; to keep them, ' +
            `they can run \`lr worktree save ${info.worktree}\` before the removal.`,
        );
    }
  }
  return messages.length > 0 ? messages.join('\n') : undefined;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const realDir = (dir: string): Promise<string> => realpath(dir).catch(() => dir);

/** A command removing a folder: `git worktree remove`, `rm -r`, or leaving the session's worktree. */
export interface Removal {
  /** The path as written. */
  spec: string;
  /** Where it is resolved from (after `cd` and `git -C`). */
  cwd: string;
  kind: 'git' | 'rm' | 'session';
}

/**
 * The folders a shell command removes that may be git worktrees: `git worktree remove <path>`
 * (with `git -C <dir>`, after `cd <dir> &&`…) and `rm -r <path>`. A best effort on the usual forms,
 * not a shell: globs, variables and substitutions are not followed.
 */
export function worktreeRemovals(command: string, cwd: string, home?: string): Removal[] {
  const found: Removal[] = [];
  let dir = cwd;
  const env = home ? { HOME: home } : process.env;
  for (const words of shellSegments(command)) {
    let t = words;
    while (t.length > 0 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0]!) || WRAPPERS.has(t[0]!))) t = t.slice(1);
    const [cmd, ...args] = t;
    if (!cmd) continue;
    if (cmd === 'cd' || cmd === 'pushd') {
      const to = args.find((a) => !a.startsWith('-'));
      dir = resolve(dir, expandHome(to ?? '~', env));
      continue;
    }
    if (basename(cmd) === 'git') {
      let gitDir = dir;
      let i = 0;
      while (i < args.length && args[i]!.startsWith('-')) {
        if (args[i] === '-C' && args[i + 1] !== undefined) gitDir = resolve(gitDir, expandHome(args[i + 1]!, env));
        i += GIT_OPTIONS_WITH_VALUE.has(args[i]!) ? 2 : 1;
      }
      if (args[i] !== 'worktree' || args[i + 1] !== 'remove') continue;
      const spec = operands(args.slice(i + 2))[0];
      if (spec) found.push({ spec: expandHome(spec, env), cwd: gitDir, kind: 'git' });
      continue;
    }
    if (basename(cmd) === 'rm') {
      const flags = args.filter((a) => a.startsWith('-') && a !== '-' && a !== '--');
      const recursive = flags.some((f) => f === '--recursive' || /^-[A-Za-z]*[rR]/.test(f));
      if (!recursive) continue;
      for (const spec of operands(args))
        if (!/[*?[]/.test(spec)) found.push({ spec: expandHome(spec, env), cwd: dir, kind: 'rm' });
    }
  }
  return found;
}

const WRAPPERS = new Set(['sudo', 'command', 'exec', 'time', 'nohup']);
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

/** The arguments that are not options (everything after `--` is one). */
function operands(args: string[]): string[] {
  const out: string[] = [];
  let options = true;
  for (const a of args) {
    if (options && a === '--') options = false;
    else if (!options || !a.startsWith('-')) out.push(a);
  }
  return out;
}

/** The words of each simple command of a shell line (split on `&&`, `||`, `;`, `|`, `&`, newlines). */
export function shellSegments(command: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      word += command.slice(i + 1, end === -1 ? undefined : end);
      inWord = true;
      i = end === -1 ? command.length : end;
    } else if (c === '"') {
      inWord = true;
      for (i++; i < command.length && command[i] !== '"'; i++) {
        if (command[i] === '\\' && i + 1 < command.length) i++;
        word += command[i];
      }
    } else if (c === '\\') {
      if (command[i + 1] === '\n') i++;
      else if (i + 1 < command.length) {
        word += command[++i];
        inWord = true;
      }
    } else if (c === ' ' || c === '\t') endWord();
    else if (c === '\n' || c === ';' || c === '&' || c === '|' || c === '(' || c === ')') endSegment();
    else {
      word += c;
      inWord = true;
    }
  }
  endSegment();
  return segments;
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

/** Whether a command line runs Claude Code: `claude …`, or a `claude` script (`node …/claude …`). */
export function runsClaude(args: string | null): boolean {
  return (args ?? '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .some((arg) => basename(arg) === 'claude');
}

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
    // On Linux, `comm` is the name of the main thread, which Node.js renames `MainThread`: the
    // command line tells then.
    if (basename(match[2]!.trim()) === 'claude' || runsClaude(await commandLine(pid))) return pid;
    pid = Number(match[1]);
  }
  return null;
}

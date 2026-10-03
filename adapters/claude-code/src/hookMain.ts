import { homedir } from 'node:os';
import {
  filesChangedSince,
  gitWorktreeOf,
  localReviewHome,
  readConfig,
  resolveWorktree,
  saveWorktreeThreads,
  SessionRegistry,
  topicOf,
  worktreeInfo,
  worktreeThreadCount,
} from '@local-review/core';
import { commandLine, findClaudePid, gitBranch, handleHook, type HookInput } from './hook';

// Entry point of the plugin's hooks. It must never get in Claude's way: whatever happens, it
// exits 0, and it prints nothing but a message meant for Claude (stdout reaches Claude's context).
async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as HookInput;
  const message = await handleHook(input, {
    registry: new SessionRegistry(localReviewHome()),
    claudePid: () => findClaudePid(),
    commandLine,
    gitBranch,
    topicOf: (path) => topicOf(path),
    gitWorktreeOf,
    filesChangedSince,
    now: () => new Date(),
    home: process.env.HOME || homedir(),
    worktrees: {
      autoSave: async () => (await readConfig()).autoSaveWorktrees,
      resolveWorktree,
      worktreeInfo,
      save: (dir) => saveWorktreeThreads(dir),
      threadCount: (dir) => worktreeThreadCount(dir),
    },
  });
  if (message && input.hook_event_name) {
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: message } }),
    );
  }
}

main()
  .catch(() => undefined)
  .finally(() => process.exit(0));

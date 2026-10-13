import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  filesChangedSince,
  gitWorktreeOf,
  silykatHome,
  readConfig,
  resolveWorktree,
  retroCadence,
  thresholdsOf,
  saveWorktreeThreads,
  SessionRegistry,
  topicOf,
  worktreeInfo,
  worktreeThreadCount,
} from '@silykat/core';
import { commandLine, findClaudePid, gitBranch, handleHook, purgeConfirmation, type HookInput } from './hook';
import { recordClaudeSession } from './sessionLog';

// Entry point of the plugin's hooks. It must never get in Claude's way: whatever happens, it
// exits 0, and it prints nothing but a message meant for Claude (stdout reaches Claude's context),
// and, before a command deleting threads for good, a request to ask the user.
async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as HookInput;
  // Deleting threads for good: the user confirms it in Claude Code's own permission prompt, even
  // if the rest of the hook fails.
  const ask = input.hook_event_name === 'PreToolUse' ? purgeConfirmation(input) : null;
  const message = await handleHook(input, {
    registry: new SessionRegistry(silykatHome()),
    claudePid: () => findClaudePid(),
    commandLine,
    gitBranch,
    topicOf: (path) => topicOf(path),
    gitWorktreeOf,
    filesChangedSince,
    now: () => new Date(),
    home: process.env.HOME || homedir(),
    // Claude Code keeps its sessions in $CLAUDE_CONFIG_DIR when it is set, else in ~/.claude.
    recordSession: (session) =>
      recordClaudeSession(
        session,
        process.env.CLAUDE_CONFIG_DIR?.trim() || join(process.env.HOME || homedir(), '.claude'),
      ),
    retroCadence: async (cwd) => {
      const config = await readConfig();
      return config.retroReminder ? retroCadence(cwd, { thresholds: thresholdsOf(config) }) : null;
    },
    worktrees: {
      keepHistory: async () => (await readConfig()).keepHistory,
      resolveWorktree,
      worktreeInfo,
      save: (dir) => saveWorktreeThreads(dir),
      threadCount: (dir) => worktreeThreadCount(dir),
    },
  }).catch(() => undefined);
  if ((message || ask) && input.hook_event_name) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: input.hook_event_name,
          ...(message ? { additionalContext: message } : {}),
          ...(ask ? { permissionDecision: 'ask', permissionDecisionReason: ask } : {}),
        },
      }),
    );
  }
}

main()
  .catch(() => undefined)
  .finally(() => process.exit(0));

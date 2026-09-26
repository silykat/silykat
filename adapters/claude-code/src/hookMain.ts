import { localReviewHome, SessionRegistry } from '@local-review/core';
import { findClaudePid, gitBranch, handleHook, type HookInput } from './hook';

// Entry point of the plugin's hooks. It must never get in Claude's way: whatever happens, it
// prints nothing (SessionStart output would be added to Claude's context) and exits 0.
async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as HookInput;
  await handleHook(input, {
    registry: new SessionRegistry(localReviewHome()),
    claudePid: () => findClaudePid(),
    gitBranch,
    now: () => new Date(),
  });
}

main()
  .catch(() => undefined)
  .finally(() => process.exit(0));

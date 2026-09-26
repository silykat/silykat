// Stand-alone Node script that writes a reply "as Claude" into a thread, from outside VS Code.
// It exercises the same path the real Claude skill will use (step 2): an external process
// appending to the store, picked up by the extension's file watcher.
//
// Usage: fake-claude --root <store root> --thread <thread id> --body <markdown> [--status needs-info|addressed|none]
import { parseArgs } from 'node:util';
import { Store, type ThreadStatus } from '@local-review/core';

const STATUSES = new Set(['needs-info', 'addressed', 'none']);

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      root: { type: 'string' },
      thread: { type: 'string' },
      body: { type: 'string' },
      status: { type: 'string', default: 'none' },
    },
  });
  const { root, thread, body, status = 'none' } = values;
  if (!root || !thread || !body) throw new Error('--root, --thread and --body are required');
  if (!STATUSES.has(status)) throw new Error(`--status must be one of: ${[...STATUSES].join(', ')}`);

  const state = await new Store(root).addComment(
    thread,
    { author: 'claude', body, reviewId: null },
    status === 'none' ? {} : { status: status as ThreadStatus },
  );
  process.stdout.write(`${state.id}: ${state.status}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`fake-claude: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

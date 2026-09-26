import { createInterface } from 'node:readline';
import { localReviewHome, SessionRegistry } from '@local-review/core';
import { LocalReviewChannel, type RpcMessage } from './channel';
import { findClaudePid } from './hook';

declare const PLUGIN_VERSION: string;

const POLL_MS = 500;

// Entry point of the channel server. Claude Code talks to it over stdio: stdout carries the
// protocol only, so anything else goes to stderr (it ends up in Claude Code's debug log).
async function main(): Promise<void> {
  const channel = new LocalReviewChannel({
    registry: new SessionRegistry(localReviewHome()),
    claudePid: await findClaudePid(process.ppid),
    send: (message) => process.stdout.write(JSON.stringify(message) + '\n'),
    now: () => Date.now(),
    version: PLUGIN_VERSION,
  });

  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    if (line.trim() === '') return;
    try {
      channel.handle(JSON.parse(line) as RpcMessage);
    } catch (err) {
      process.stderr.write(`local-review channel: ignored a message: ${String(err)}\n`);
    }
  });
  lines.on('close', () => process.exit(0)); // Claude Code is gone

  let polling = false;
  setInterval(() => {
    if (polling) return;
    polling = true;
    channel
      .poll()
      .catch((err) => process.stderr.write(`local-review channel: ${String(err)}\n`))
      .finally(() => (polling = false));
  }, POLL_MS);
}

void main();

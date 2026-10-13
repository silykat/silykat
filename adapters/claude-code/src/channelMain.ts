import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { silykatHome, SessionRegistry } from '@silykat/core';
import { SilykatChannel, type RpcMessage } from './channel';
import { findClaudePid } from './hook';

/**
 * The plugin's version, read when the server starts rather than built into the bundle: a release
 * changes plugin.json only, and the committed bundle stays the same.
 */
function pluginVersion(): string {
  try {
    const manifest = join(__dirname, '..', '.claude-plugin', 'plugin.json');
    return (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

const POLL_MS = 500;

// Entry point of the channel server. Claude Code talks to it over stdio: stdout carries the
// protocol only, so anything else goes to stderr (it ends up in Claude Code's debug log).
async function main(): Promise<void> {
  const channel = new SilykatChannel({
    registry: new SessionRegistry(silykatHome()),
    claudePid: await findClaudePid(process.ppid),
    send: (message) => process.stdout.write(JSON.stringify(message) + '\n'),
    now: () => Date.now(),
    version: pluginVersion(),
  });

  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    if (line.trim() === '') return;
    try {
      channel.handle(JSON.parse(line) as RpcMessage);
    } catch (err) {
      process.stderr.write(`silykat channel: ignored a message: ${String(err)}\n`);
    }
  });
  lines.on('close', () => process.exit(0)); // Claude Code is gone

  let polling = false;
  setInterval(() => {
    if (polling) return;
    polling = true;
    channel
      .poll()
      .catch((err) => process.stderr.write(`silykat channel: ${String(err)}\n`))
      .finally(() => (polling = false));
  }, POLL_MS);
}

void main();

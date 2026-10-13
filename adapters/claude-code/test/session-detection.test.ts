import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The real process tree, with the committed bundles: a process named `claude` runs the hook and `slk`
// through a shell, as Claude Code does. This is what differs between macOS and Linux (`ps`).
const plugin = resolve(__dirname, '../plugin');
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'slk-detect-'));
  await mkdir(join(dir, 'bin'));
  // A copy of Node.js named `claude`: `ps` reports that name for it.
  await copyFile(process.execPath, join(dir, 'bin', 'claude'));
  await chmod(join(dir, 'bin', 'claude'), 0o755);
  await writeFile(
    join(dir, 'fake-claude.mjs'),
    `import { execFileSync } from 'node:child_process';
const { NODE_BIN, HOOK, SLK, WORK } = process.env;
const input = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'detect-1', cwd: WORK });
execFileSync('/bin/sh', ['-c', '"$NODE_BIN" "$HOOK"'], { input, env: process.env });
const slk = execFileSync('/bin/sh', ['-c', 'cd "$WORK" && "$NODE_BIN" "$SLK" subscribe --path .'], { env: process.env });
process.stdout.write(JSON.stringify({ pid: process.pid, slk: slk.toString() }));
`,
  );
  await mkdir(join(dir, 'work'));
}, 30_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('session detection through the process tree', () => {
  it('registers the claude process, and slk finds its session from a shell below it', async () => {
    const home = join(dir, 'home');
    const work = join(dir, 'work');
    const { stdout } = await promisify(execFile)(join(dir, 'bin', 'claude'), [join(dir, 'fake-claude.mjs')], {
      env: {
        ...process.env,
        SILYKAT_HOME: home,
        NODE_BIN: process.execPath,
        HOOK: join(plugin, 'hooks', 'silykat-hook.js'),
        SLK: join(plugin, 'bin', 'slk'),
        WORK: work,
      },
    });
    const { pid, slk } = JSON.parse(stdout) as { pid: number; slk: string };

    const session = JSON.parse(await readFile(join(home, 'sessions', 'detect-1.json'), 'utf8')) as { pid: number };
    expect(session.pid).toBe(pid);
    // `slk subscribe` fails outside a registered session: it found its session from its parents.
    expect(slk).toContain('Subscribed to');
  }, 30_000);
});

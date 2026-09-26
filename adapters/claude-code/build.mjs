// Builds the Claude Code plugin. Claude Code installs plugins from git, so these bundles are
// committed: `lr` in plugin/bin/ (on the PATH of Claude's shell), the hooks' script and the
// channel server.
// `--out <dir>` builds elsewhere, to check that the committed bundles are up to date.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const outArg = process.argv.indexOf('--out');
const plugin = outArg > 0 ? resolve(process.argv[outArg + 1]) : join(here, 'plugin');

execFileSync('npm', ['run', 'build', '--silent', '-w', 'packages/cli'], { cwd: repo, stdio: 'inherit' });
mkdirSync(join(plugin, 'bin'), { recursive: true });
const lr = join(plugin, 'bin', 'lr');
copyFileSync(join(repo, 'packages', 'cli', 'dist', 'lr.js'), lr);
chmodSync(lr, 0o755);

const { version } = JSON.parse(readFileSync(join(here, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8'));

/** A Node script of the plugin, self-contained. */
async function bundle(entry, outfile) {
  mkdirSync(dirname(outfile), { recursive: true });
  await esbuild.build({
    entryPoints: [join(here, 'src', entry)],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    banner: { js: '#!/usr/bin/env node' },
    define: { PLUGIN_VERSION: JSON.stringify(version) },
    // Paths in the bundle's comments are relative to this folder, wherever the build is run from:
    // builds are then byte-identical, which the freshness check relies on.
    absWorkingDir: here,
    logLevel: 'warning',
  });
  chmodSync(outfile, 0o755);
}

await bundle('hookMain.ts', join(plugin, 'hooks', 'local-review-hook.js'));
await bundle('channelMain.ts', join(plugin, 'channel', 'local-review-channel.js'));
console.log(`Claude Code plugin built: ${plugin}`);

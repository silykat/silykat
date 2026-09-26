// Builds the Claude Code plugin. Claude Code installs plugins from git, so these bundles are
// committed: `lr` in plugin/bin/ (on the PATH of Claude's shell) and the hooks' script.
// `--out <dir>` builds elsewhere, to check that the committed bundles are up to date.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
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

const hook = join(plugin, 'hooks', 'local-review-hook.js');
await esbuild.build({
  entryPoints: [join(here, 'src', 'hookMain.ts')],
  outfile: hook,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  banner: { js: '#!/usr/bin/env node' },
  // Paths in the bundle's comments are relative to this folder, wherever the build is run from:
  // builds are then byte-identical, which the freshness check relies on.
  absWorkingDir: here,
  logLevel: 'warning',
});
chmodSync(hook, 0o755);
console.log(`Claude Code plugin built: ${plugin}`);

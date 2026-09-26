// Builds the Claude Code plugin: bundles the neutral `lr` CLI into plugin/bin/, which Claude Code
// puts on the PATH of its shell while the plugin is enabled.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

execFileSync('npm', ['run', 'build', '-w', 'packages/cli'], { cwd: repo, stdio: 'inherit' });
mkdirSync(join(here, 'plugin', 'bin'), { recursive: true });
const target = join(here, 'plugin', 'bin', 'lr');
copyFileSync(join(repo, 'packages', 'cli', 'dist', 'lr.js'), target);
chmodSync(target, 0o755);
console.log(`Claude Code plugin built: ${join(here, 'plugin')}`);

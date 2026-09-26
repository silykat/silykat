// The Claude Code plugin is installed from git, so its bundled `lr` is committed. This check fails
// when that bundle is older than the CLI's sources: run `npm run build:claude-plugin` and commit it.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repo = resolve(new URL('..', import.meta.url).pathname);
execFileSync('npm', ['run', 'build', '--silent', '-w', 'packages/cli'], { cwd: repo, stdio: 'ignore' });
const fresh = readFileSync(join(repo, 'packages', 'cli', 'dist', 'lr.js'));
let shipped;
try {
  shipped = readFileSync(join(repo, 'adapters', 'claude-code', 'plugin', 'bin', 'lr'));
} catch {
  shipped = undefined;
}
if (!shipped || !fresh.equals(shipped)) {
  console.error(
    'check-plugin-bundle: adapters/claude-code/plugin/bin/lr is out of date. Run `npm run build:claude-plugin` and commit it.',
  );
  process.exit(1);
}
console.log('check-plugin-bundle: the plugin ships the current lr');

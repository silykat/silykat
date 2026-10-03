// The Claude Code plugin is installed from git, so its bundles (lr, the hooks' script, the channel server) are
// committed. This check rebuilds them elsewhere and fails when the committed ones are out of date.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(new URL('..', import.meta.url).pathname);
const plugin = join(repo, 'adapters', 'claude-code', 'plugin');
const fresh = mkdtempSync(join(tmpdir(), 'lr-plugin-'));
try {
  execFileSync('node', [join(repo, 'adapters', 'claude-code', 'build.mjs'), '--out', fresh], {
    cwd: repo,
    stdio: 'ignore',
  });
  const stale = ['bin/lr', 'bin/lr-retro', 'hooks/local-review-hook.js', 'channel/local-review-channel.js'].filter(
    (file) => {
      try {
        return !readFileSync(join(fresh, file)).equals(readFileSync(join(plugin, file)));
      } catch {
        return true;
      }
    },
  );
  if (stale.length > 0) {
    console.error(
      `check-plugin-bundle: out of date in adapters/claude-code/plugin/: ${stale.join(', ')}. Run \`npm run build:claude-plugin\` and commit.`,
    );
    process.exit(1);
  }
  console.log('check-plugin-bundle: the plugin ships the current bundles');
} finally {
  rmSync(fresh, { recursive: true, force: true });
}

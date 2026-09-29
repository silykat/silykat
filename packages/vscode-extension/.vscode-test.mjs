import { defineConfig } from '@vscode/test-cli';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Fresh git repository used as the test workspace.
const workspace = mkdtempSync(join(tmpdir(), 'lr-it-'));
execFileSync('git', ['init', '-q'], { cwd: workspace });
writeFileSync(
  join(workspace, 'sample.ts'),
  Array.from({ length: 30 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n') + '\n',
);

// A private Local Review home: the tests' agent sessions never mix with real ones.
const localReviewHome = mkdtempSync(join(tmpdir(), 'lr-home-'));

export default defineConfig({
  tests: [
    {
      env: { LOCAL_REVIEW_HOME: localReviewHome },
      files: 'out/test/integration/**/*.test.js',
      workspaceFolder: workspace,
      version: 'stable',
      // A short user data dir: macOS caps socket paths at ~104 chars, and VS Code puts one in there.
      launchArgs: ['--disable-extensions', '--user-data-dir', mkdtempSync(join(tmpdir(), 'lr-ud-'))],
      mocha: { ui: 'bdd', timeout: 20000 },
    },
  ],
  // `npm run coverage:integration` (from the repository root): the code the extension runs, not the
  // development tools nor the `lr` bundle that some tests start as a separate process.
  coverage: {
    exclude: ['**/node_modules/**', '**/test/**', '**/src/dev/**', '**/cli/dist/**'],
    reporter: ['text-summary', 'html', 'json-summary'],
  },
});

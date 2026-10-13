import { defineConfig } from '@vscode/test-cli';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Fresh git repository used as the test workspace.
const workspace = mkdtempSync(join(tmpdir(), 'slk-it-'));
execFileSync('git', ['init', '-q'], { cwd: workspace });
writeFileSync(
  join(workspace, 'sample.ts'),
  Array.from({ length: 30 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n') + '\n',
);

// A private silykat home: the tests' agent sessions never mix with real ones.
const silykatHome = mkdtempSync(join(tmpdir(), 'slk-home-'));

export default defineConfig({
  tests: [
    {
      env: { SILYKAT_HOME: silykatHome },
      files: 'out/test/integration/**/*.test.js',
      workspaceFolder: workspace,
      version: 'stable',
      // A short user data dir: macOS caps socket paths at ~104 chars, and VS Code puts one in there.
      launchArgs: ['--disable-extensions', '--user-data-dir', mkdtempSync(join(tmpdir(), 'slk-ud-'))],
      mocha: { ui: 'bdd', timeout: 20000 },
    },
  ],
  // `npm run coverage:integration` (from the repository root): the code the extension runs, not the
  // development tools nor the `slk` bundle that some tests start as a separate process.
  coverage: {
    exclude: ['**/node_modules/**', '**/test/**', '**/src/dev/**', '**/cli/dist/**'],
    reporter: ['text-summary', 'html', 'json-summary'],
  },
});

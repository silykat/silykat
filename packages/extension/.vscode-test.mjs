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

export default defineConfig({
  files: 'out/test/integration/**/*.test.js',
  workspaceFolder: workspace,
  version: 'stable',
  launchArgs: ['--disable-extensions'],
  mocha: { ui: 'bdd', timeout: 20000 },
});

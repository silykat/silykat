import * as esbuild from 'esbuild';
import { globSync } from 'node:fs';

const production = process.argv.includes('--production');
const tests = process.argv.includes('--tests');

const common = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['vscode'],
  logLevel: 'warning',
};

await esbuild.build({
  ...common,
  entryPoints: {
    extension: 'src/extension.ts',
    // Spawned as a separate process by "Simulate Claude Reply".
    'fake-claude': 'src/dev/fake-claude.ts',
  },
  outdir: 'dist',
  sourcemap: !production,
  minify: production,
});

if (tests) {
  await esbuild.build({
    ...common,
    entryPoints: globSync('test/integration/**/*.test.ts'),
    outdir: 'out/test/integration',
    external: ['vscode', 'mocha'],
    sourcemap: true,
  });
}

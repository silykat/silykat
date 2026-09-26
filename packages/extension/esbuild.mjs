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
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
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

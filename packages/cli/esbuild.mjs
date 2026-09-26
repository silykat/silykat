import * as esbuild from 'esbuild';

// A single file with no dependency to install: agent adapters ship it as is.
await esbuild.build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/lr.js',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'warning',
});

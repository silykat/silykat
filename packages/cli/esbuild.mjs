import * as esbuild from 'esbuild';

// A single file with no dependency to install: agent adapters ship it as is.
await esbuild.build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/slk.js',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  banner: { js: '#!/usr/bin/env node' },
  // Reproducible output wherever the build runs from (paths in comments are relative to this folder).
  absWorkingDir: new URL('.', import.meta.url).pathname,
  logLevel: 'warning',
});

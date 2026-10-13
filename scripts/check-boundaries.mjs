// Keeps the architecture honest: neutral packages never depend on agent adapters, and each
// package only depends on what it is allowed to (see the "architecture" section of the README).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const repo = resolve(new URL('..', import.meta.url).pathname);
const ALLOWED = {
  'packages/core': [],
  'packages/cli': ['@silykat/core'],
  'packages/vscode-extension': ['@silykat/core'],
  adapters: ['@silykat/core', '@silykat/cli'],
};

function* sources(dir) {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', 'dist', 'out', '.vscode-test', 'bin'].includes(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.(ts|mts|cts|mjs|js)$/.test(entry)) yield path;
  }
}

const problems = [];
for (const [area, allowed] of Object.entries(ALLOWED)) {
  const areaDir = join(repo, area);
  let files;
  try {
    files = [...sources(areaDir)];
  } catch {
    continue;
  }
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const [, spec] of text.matchAll(/(?:from|import|require\()\s*['"]([^'"]+)['"]/g)) {
      const rel = relative(repo, file);
      if (spec.startsWith('@silykat/') && !allowed.includes(spec)) {
        problems.push(`${rel}: imports ${spec}, not allowed in ${area}`);
      }
      if (spec.startsWith('.')) {
        const target = relative(repo, resolve(join(file, '..'), spec));
        const pkgRoot = area === 'adapters' ? rel.split(sep).slice(0, 2).join(sep) : area;
        if (!target.startsWith(pkgRoot)) problems.push(`${rel}: relative import ${spec} leaves ${pkgRoot}`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error('Architecture boundaries violated:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}
console.log('check-boundaries: neutral packages and adapters respect their dependencies');

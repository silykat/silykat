// Fails when the coverage of the integration tests drops below its floor (vitest checks the unit
// tests itself, see vitest.config.mjs). Raise the floors when the coverage goes up, never lower them.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FLOORS = { statements: 92, branches: 83, functions: 92, lines: 92 };

const repo = resolve(new URL('..', import.meta.url).pathname);
const { total } = JSON.parse(readFileSync(resolve(repo, 'coverage/integration/coverage-summary.json'), 'utf8'));
const failures = Object.entries(FLOORS)
  .filter(([metric, floor]) => total[metric].pct < floor)
  .map(([metric, floor]) => `${metric}: ${total[metric].pct}% (floor ${floor}%)`);
if (failures.length > 0) {
  console.error(`Integration test coverage dropped below its floor:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('Integration test coverage is above its floors.');

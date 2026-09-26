// Fails the build if the bundle can reach the network: the extension must stay 100 % local.
import { readFileSync } from 'node:fs';

const files = ['extension.js', 'fake-agent.js'];
const forbidden = /require\(["'](?:node:)?(?:http|https|http2|net|tls|dgram|undici)["']\)|\bfetch\s*\(|\bWebSocket\b|\bXMLHttpRequest\b/g;
let failed = false;
for (const file of files) {
  const bundle = readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8');
  const hits = [...new Set(bundle.match(forbidden) ?? [])];
  if (hits.length > 0) {
    console.error(`Network access found in dist/${file}: ${hits.join(', ')}`);
    failed = true;
  }
}
if (failed) process.exit(1);
console.log(`check-local-only: no network access in ${files.join(', ')}`);

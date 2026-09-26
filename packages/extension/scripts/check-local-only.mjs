// Fails the build if the bundle can reach the network: the extension must stay 100 % local.
import { readFileSync } from 'node:fs';

const bundle = readFileSync(new URL('../dist/extension.js', import.meta.url), 'utf8');
const forbidden = /require\(["'](?:node:)?(?:http|https|http2|net|tls|dgram|undici)["']\)|\bfetch\s*\(|\bWebSocket\b|\bXMLHttpRequest\b/g;
const hits = [...new Set(bundle.match(forbidden) ?? [])];
if (hits.length > 0) {
  console.error(`Network access found in dist/extension.js: ${hits.join(', ')}`);
  process.exit(1);
}
console.log('check-local-only: no network access in the bundle');

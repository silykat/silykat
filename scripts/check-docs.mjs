// The user guide (docs/guide/) is published on silykat.com/docs by the website, which reads it at the latest
// release tag. The site's build fails, or a page renders badly, when a page breaks the rules below: this check
// catches it in the pull request. See "Documentation" in CONTRIBUTING.md.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SECTIONS = ['getting-started', 'guide', 'agents', 'reference'];

/** GitHub's anchor for a heading: lower case, punctuation dropped, spaces to hyphens. */
export function slug(heading) {
  const text = heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links and images: their text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__|\*|_)(.+?)\1/g, '$2');
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
    .replace(/ /g, '-');
}

/** Front matter fields (`key: value` lines), or `undefined` when the page has none. */
function frontMatter(lines) {
  if (lines[0] !== '---') return undefined;
  const end = lines.indexOf('---', 1);
  if (end < 0) return undefined;
  const fields = {};
  for (const line of lines.slice(1, end)) {
    const m = /^([a-z]+):\s*(.*)$/.exec(line);
    if (m) fields[m[1]] = m[2].trim();
  }
  return { fields, end };
}

/** The lines of a page outside fenced code blocks, with their 1-based number, and the fences themselves. */
function scan(lines, from) {
  const prose = [];
  const fences = [];
  let fence;
  for (let i = from; i < lines.length; i++) {
    const line = lines[i];
    const open = /^(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (open && line.startsWith(fence.marker) && open[2].trim() === '') fence = undefined;
      else fence.body.push({ n: i + 1, line });
    } else if (open) {
      fence = { marker: open[1], lang: open[2].trim(), n: i + 1, body: [] };
      fences.push(fence);
    } else prose.push({ n: i + 1, line });
  }
  return { prose, fences };
}

/** Headings of a page, with their anchors (GitHub numbers the duplicates: `-1`, `-2`…). */
function headings(prose) {
  const seen = new Map();
  return prose
    .map(({ n, line }) => ({ n, m: /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line) }))
    .filter(({ m }) => m)
    .map(({ n, m }) => {
      const base = slug(m[2]);
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      return { n, level: m[1].length, text: m[2], anchor: count === 0 ? base : `${base}-${count}` };
    });
}

/** Inline code removed, so that its content is never taken for a link or HTML. */
const withoutCode = (line) => line.replace(/`+[^`]*`+/g, '');

/** Checks every page of `dir`; returns the errors, as `file:line: message`. */
export function checkDocs(dir) {
  const errors = [];
  const pages = readdirSync(dir).filter((f) => f.endsWith('.md'));
  const parsed = new Map();
  for (const file of pages) {
    const lines = readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n').split('\n');
    const fm = frontMatter(lines);
    const { prose, fences } = scan(lines, fm ? fm.end + 1 : 0);
    parsed.set(file, { lines, fm, prose, fences, headings: headings(prose) });
  }
  const anchorsOf = (file) => new Set(parsed.get(file)?.headings.map((h) => h.anchor) ?? []);

  for (const [file, { lines, fm, prose, fences, headings: hs }] of parsed) {
    const error = (n, message) => errors.push(`${file}:${n}: ${message}`);

    if (!fm) error(1, 'no front matter (--- description, section, order ---)');
    else {
      const { description, section, order } = fm.fields;
      if (!description) error(1, 'front matter: `description` is missing');
      if (!section) error(1, 'front matter: `section` is missing');
      else if (!SECTIONS.includes(section))
        error(1, `front matter: unknown section "${section}" (${SECTIONS.join(', ')})`);
      if (order === undefined) error(1, 'front matter: `order` is missing');
      else if (!/^\d+$/.test(order)) error(1, `front matter: \`order\` must be a whole number, not "${order}"`);
    }

    const titles = hs.filter((h) => h.level === 1);
    if (titles.length !== 1) error(titles[1]?.n ?? 1, `one \`#\` title per page, found ${titles.length}`);
    const first = prose.find(({ line }) => line.trim() !== '');
    if (titles.length > 0 && first?.n !== titles[0].n)
      error(first?.n ?? 1, 'the `#` title must come right after the front matter');
    hs.forEach((h, i) => {
      const previous = i === 0 ? 0 : hs[i - 1].level;
      if (h.level > previous + 1)
        error(h.n, `heading level skipped: ${'#'.repeat(h.level)} after ${'#'.repeat(previous) || 'nothing'}`);
    });

    lines.forEach((line, i) => {
      if (/[—–]/.test(line))
        error(i + 1, 'em dash (—) or en dash (–): use a comma, a colon, parentheses or a new sentence');
    });

    for (const f of fences) {
      if (!f.lang) error(f.n, 'code block without a language (sh, json, text…)');
      else if (f.lang === 'mermaid') error(f.n, 'Mermaid is not supported by the site');
      if (['sh', 'bash', 'shell', 'zsh'].includes(f.lang))
        for (const { n, line } of f.body)
          if (/^\s*\$\s/.test(line)) error(n, 'no `$` before commands: the copy button copies the block as is');
    }

    for (const { n, line } of prose) {
      const text = withoutCode(line);
      if (/<\/?[a-zA-Z][\w-]*(\s[^>]*)?\/?>|<!--/.test(text)) error(n, 'raw HTML is not supported by the site');
      for (const m of text.matchAll(/(!?)\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g)) {
        const [, bang, label, target] = m;
        if (bang && label.trim() === '') error(n, `image without alternative text: ${target}`);
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // https:, mailto:…
        const [path, anchor] = target.split('#');
        if (path === '') {
          if (anchor && !anchorsOf(file).has(anchor)) error(n, `no heading for the anchor #${anchor}`);
          continue;
        }
        const resolved = resolve(dir, path);
        const inside = relative(dir, resolved);
        if (inside.startsWith('..')) {
          error(n, `link outside docs/guide/ (${target}): use the full GitHub URL`);
          continue;
        }
        if (!existsSync(resolved) || !statSync(resolved).isFile()) {
          error(n, `broken link: ${target}`);
          continue;
        }
        if (bang && !inside.startsWith(`images/`)) error(n, `images go in docs/guide/images/: ${target}`);
        if (anchor !== undefined) {
          if (!inside.endsWith('.md')) error(n, `anchor on a file that is not a page: ${target}`);
          else if (!anchorsOf(inside).has(anchor)) error(n, `no heading for the anchor #${anchor} in ${inside}`);
        }
      }
    }
  }
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'guide');
  const errors = checkDocs(dir);
  if (errors.length > 0) {
    for (const e of errors) console.error(`check-docs: docs/guide/${e}`);
    process.exit(1);
  }
  console.log('check-docs: the user guide follows the rules of the site');
}

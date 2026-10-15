// Tests of scripts/check-docs.mjs: each rule of the user guide is caught (run by `npm test`, with `node --test`).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { checkDocs, slug } from './check-docs.mjs';

const roots = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

const header = (extra = '') => `---\ndescription: A page.\nsection: guide\norder: 1\n${extra}---\n\n`;

/** A guide folder with these pages (name → content), plus a valid `other.md` and an image. */
function guide(pages) {
  const dir = mkdtempSync(join(tmpdir(), 'slk-docs-'));
  roots.push(dir);
  mkdirSync(join(dir, 'images'));
  writeFileSync(join(dir, 'images', 'shot.webp'), '');
  writeFileSync(join(dir, 'other.md'), `${header()}# Other\n\n## A section\n\nText.\n`);
  for (const [name, content] of Object.entries(pages)) writeFileSync(join(dir, name), content);
  return dir;
}

/** The errors of one page, without its file name. */
const errorsOf = (content) => checkDocs(guide({ 'page.md': content })).map((e) => e.replace(/^page\.md:/, ''));

void describe('check-docs', () => {
  void it('accepts a page that follows the rules', () => {
    const page = `${header()}# Title\n\nSee [other](./other.md#a-section), [here](#more) and [the site](https://silykat.com).\n\n![A shot](./images/shot.webp)\n\n## More\n\n\`\`\`sh\nslk review status\n\`\`\`\n\nInline \`<id>\` code is fine.\n`;
    assert.deepEqual(errorsOf(page), []);
  });

  void it('computes anchors like GitHub', () => {
    assert.equal(
      slug('3. Launch Claude Code with the silykat channel'),
      '3-launch-claude-code-with-the-silykat-channel',
    );
    assert.equal(slug('The Jev key (optional)'), 'the-jev-key-optional');
    assert.equal(slug('`reports` (the default, finer)'), 'reports-the-default-finer');
    assert.equal(slug('Did last time’s changes help?'), 'did-last-times-changes-help');
  });

  void it('requires the front matter', () => {
    assert.match(errorsOf('# Title\n')[0], /no front matter/);
    assert.match(errorsOf('---\nsection: guide\norder: 1\n---\n\n# Title\n')[0], /`description` is missing/);
    assert.match(errorsOf('---\ndescription: D.\norder: 1\n---\n\n# Title\n')[0], /`section` is missing/);
    assert.match(
      errorsOf('---\ndescription: D.\nsection: misc\norder: 1\n---\n\n# Title\n')[0],
      /unknown section "misc"/,
    );
    assert.match(errorsOf('---\ndescription: D.\nsection: guide\n---\n\n# Title\n')[0], /`order` is missing/);
    assert.match(errorsOf('---\ndescription: D.\nsection: guide\norder: first\n---\n\n# Title\n')[0], /whole number/);
  });

  void it('requires one `#` title, right after the front matter', () => {
    assert.match(errorsOf(`${header()}## Only a section\n`).join('\n'), /one `#` title per page, found 0/);
    assert.match(errorsOf(`${header()}# One\n\n# Two\n`)[0], /found 2/);
    assert.match(errorsOf(`${header()}Intro first.\n\n# Title\n`)[0], /right after the front matter/);
    assert.deepEqual(errorsOf(`${header()}# Title\n\n\`\`\`sh\n# a shell comment\n\`\`\`\n`), []);
  });

  void it('refuses skipped heading levels', () => {
    assert.match(errorsOf(`${header()}# Title\n\n### Too deep\n`)[0], /level skipped: ### after #/);
  });

  void it('refuses em and en dashes', () => {
    assert.match(errorsOf(`${header()}# Title\n\nOne — two.\n`)[0], /^9: em dash/);
    assert.match(errorsOf(`${header()}# Title\n\nPages 1–2.\n`)[0], /en dash/);
  });

  void it('checks code blocks', () => {
    assert.match(errorsOf(`${header()}# Title\n\n\`\`\`\nslk\n\`\`\`\n`)[0], /without a language/);
    assert.match(errorsOf(`${header()}# Title\n\n\`\`\`mermaid\ngraph TD\n\`\`\`\n`)[0], /Mermaid/);
    assert.match(
      errorsOf(`${header()}# Title\n\n\`\`\`sh\n$ slk review status\n\`\`\`\n`)[0],
      /no `\$` before commands/,
    );
  });

  void it('refuses raw HTML', () => {
    assert.match(errorsOf(`${header()}# Title\n\n<details>Hidden</details>\n`)[0], /raw HTML/);
    assert.match(errorsOf(`${header()}# Title\n\n<!-- a comment -->\n`)[0], /raw HTML/);
  });

  void it('checks links and their anchors', () => {
    assert.match(errorsOf(`${header()}# Title\n\n[x](./missing.md)\n`)[0], /broken link: \.\/missing\.md/);
    assert.match(
      errorsOf(`${header()}# Title\n\n[x](./other.md#nowhere)\n`)[0],
      /no heading for the anchor #nowhere in other\.md/,
    );
    assert.match(errorsOf(`${header()}# Title\n\n[x](#nowhere)\n`)[0], /no heading for the anchor #nowhere/);
    assert.match(
      errorsOf(`${header()}# Title\n\n[x](../CONTRIBUTING.md)\n`)[0],
      /outside docs\/guide\/.*full GitHub URL/,
    );
  });

  void it('checks images', () => {
    assert.match(errorsOf(`${header()}# Title\n\n![](./images/shot.webp)\n`)[0], /without alternative text/);
    assert.match(errorsOf(`${header()}# Title\n\n![A shot](./images/none.webp)\n`)[0], /broken link/);
    assert.match(errorsOf(`${header()}# Title\n\n![A page](./other.md)\n`)[0], /images go in docs\/guide\/images\//);
  });
});

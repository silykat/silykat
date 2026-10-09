import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAnchorContext, readConfig, recordAgentSessions, Store, type Anchor } from '@local-review/core';
import { runCli } from '../src/cli';

let base: string;
let work: string;
const env = () => ({ LOCAL_REVIEW_HOME: join(base, 'machine'), HOME: join(base, 'home') });

async function lr(args: string[]) {
  let out = '';
  let err = '';
  const code = await runCli(args, {
    cwd: work,
    env: env(),
    out: (t) => (out += t + '\n'),
    err: (t) => (err += t + '\n'),
    readStdin: async () => '',
    ancestors: async () => [],
  });
  return { code, out, err };
}

const anchor = (): Anchor => ({
  path: 'src/a.ts',
  source: 'worktree',
  ref: null,
  sha: null,
  ...buildAnchorContext('const a = 1;\n', { startLine: 1, endLine: 1 }),
});
const comment = async (body: string) =>
  (await new Store(work).createThread(anchor(), { author: 'user', body, reviewId: null })).id;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'lr-retro-sources-cli-')));
  work = join(base, 'work');
  await mkdir(work);
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('the sources of a retro', () => {
  it('are shown by lr retro scope with their settings, and asked for at the first retro of a project', async () => {
    await comment('Use UTC');
    const first = await lr(['retro', 'scope']);
    expect(first.out).toContain('## Sources');
    expect(first.out).toContain(
      '- **Reviews (your review threads)**: ask, asked at each retro (the default). In this period: 1 thread.',
    );
    expect(first.out).toContain(
      '- **Audit of the setup (/doctor prompt-audit)**: ask, asked at each retro (the default). About 8 min.',
    );
    expect(first.out).toContain('This project has no retro settings yet');
    expect(first.out).toContain(`lr retro sources --root ${work} --set reviews=<yes|no|ask>`);

    const set = await lr(['retro', 'sources', '--set', 'reviews=yes', '--set', 'sessions=ask', '--set', 'audit=no']);
    expect(set.code).toBe(0);
    expect(set.out).toContain(`Saved for the project (${work}).`);
    expect(set.out).toContain("- **Reviews (your review threads)**: yes, always read (the project's setting).");
    expect(set.out).toContain(
      "- **Audit of the setup (/doctor prompt-audit)**: no, never read (the project's setting).",
    );
    expect(JSON.parse(await readFile(join(work, '.local-review', 'config.json'), 'utf8'))).toEqual({
      retroSourceReviews: 'yes',
      retroSourceSessions: 'ask',
      retroSourceAudit: 'no',
    });
    expect((await lr(['retro', 'scope'])).out).not.toContain('no retro settings yet');
    // The machine's settings are untouched.
    expect((await readConfig(env())).retroSourceReviews).toBe('ask');

    expect((await lr(['retro', 'sources', '--set', 'threads=yes'])).code).not.toBe(0);
    expect((await lr(['retro', 'sources', '--set', 'audit=always'])).err).toContain(
      '--set audit takes yes, no, ask, not "always"',
    );
  });

  it('can be changed with lr config, for the project or for the machine', async () => {
    const set = await lr(['config', 'set', 'retro-source-audit', 'no', '--project']);
    expect(set.out).toContain(`retro-source-audit is now no for the project (${work}).`);
    const shown = await lr(['config', '--project']);
    expect(shown.out).toContain('  retro-source-audit: no');
    expect(shown.out).toContain("  retro-source-reviews: not set (the machine's: ask)");
    expect((await lr(['config', 'set', 'keep-history', 'off', '--project'])).err).toContain(
      'a project sets retro-source-reviews, retro-source-sessions, retro-source-audit only',
    );
    expect((await lr(['config', 'set', 'retro-source-audit', 'sometimes', '--project'])).err).toContain(
      'retro-source-audit takes yes or no or ask, not "sometimes"',
    );
    expect((await lr(['config', 'reset', '--project'])).err).toContain('lr config takes "set" or nothing, not "reset"');
    expect(JSON.parse((await lr(['config', '--project', '--format', 'json'])).out)).toEqual({ retroSourceAudit: 'no' });
    expect((await lr(['retro', 'sources'])).out).toContain(
      "- **Audit of the setup (/doctor prompt-audit)**: no, never read (the project's setting).",
    );
    expect((await lr(['retro', 'sources', '--set', 'reviews'])).err).toContain('--set reviews takes yes, no, ask');
    expect((await lr(['config', 'set', 'retro-source-sessions', 'no'])).code).toBe(0);
    expect((await readConfig(env())).retroSourceSessions).toBe('no');
    expect((await lr(['config'])).out).toContain('  retro-source-sessions: no');
  });

  it('let a retro run without review threads, and never without a source', async () => {
    expect((await lr(['retro', 'start', '--all'])).err).toContain(
      'no thread in this period: leave the reviews out of the sources (--sources sessions,audit)',
    );
    expect((await lr(['retro', 'start', '--all', '--sources', 'reviews,audit'])).err).toContain('(--sources audit)');
    expect((await lr(['retro', 'start', '--all', '--sources', ''])).err).toContain('at least one source');
    expect((await lr(['retro', 'start', '--all', '--sources', 'threads'])).err).toContain(
      '--sources takes reviews, sessions, audit',
    );

    const started = await lr(['retro', 'start', '--all', '--sources', 'audit,sessions']);
    expect(started.code).toBe(0);
    expect(started.out).toMatch(
      /^Retro rt_\w+ started: no review thread \(reviews left out\), .*\. Sources: sessions, audit\.$/m,
    );
    const id = /Retro (rt_\w+)/.exec(started.out)![1]!;
    const shown = await lr(['retro', 'show', id]);
    expect(shown.out).toContain(
      'Sources: Reviews (your review threads): not read · Sessions (your sessions with the agent): read · Audit of the setup (/doctor prompt-audit): read.',
    );
    expect(shown.out).not.toContain('not classified');

    // What reads the threads is refused.
    for (const step of ['classify', 'threads'])
      expect((await lr(['retro', 'input', id, '--for', step])).err).toContain(
        `retro ${id} does not read reviews (your review threads)`,
      );
    expect((await lr(['retro', 'findings', id, '--source', 'threads', '--body', '{"findings":[]}'])).code).not.toBe(0);
    expect((await lr(['retro', 'classification', id, '--by', 'jev', '--body', '{}'])).code).not.toBe(0);
    // The sources it reads are not.
    expect((await lr(['retro', 'input', id, '--for', 'sessions'])).code).toBe(0);
    expect((await lr(['retro', 'findings', id, '--source', 'audit', '--body', '{"findings":[]}'])).code).toBe(0);
  });

  it('read only the threads when the retro reads only the reviews', async () => {
    await comment('Use UTC');
    const started = await lr(['retro', 'start', '--all', '--sources', 'reviews', '--format', 'json']);
    const r = JSON.parse(started.out) as { id: string; sources: string[]; threads: string[] };
    expect(r.sources).toEqual(['reviews']);
    expect(r.threads).toHaveLength(1);
    expect((await lr(['retro', 'input', r.id, '--for', 'audit'])).err).toContain('does not read audit of the setup');
    expect((await lr(['retro', 'input', r.id, '--for', 'sessions'])).err).toContain('does not read sessions');
  });
});

describe('the retro cadence', () => {
  it('counts the agent sessions next to the threads', async () => {
    await recordAgentSessions([{ id: 's1', agent: 'Claude', cwd: work, startedAt: new Date().toISOString() }], {
      env: env(),
    });
    const out = (await lr(['retro', 'cadence'])).out;
    expect(out).toMatch(
      /^No retro due yet: 0 days, 0 B of review threads \(0\) and 1 agent session since the first agent session/,
    );
  });
});

describe('a retro without review threads', () => {
  it('shows a change of the last retro it could not measure, and proposals on sessions without numbers of threads', async () => {
    const first = await lr(['retro', 'start', '--all', '--sources', 'audit', '--format', 'json']);
    const id = (JSON.parse(first.out) as { id: string }).id;
    const proposal = {
      column: 'improve',
      subject: 'Stale rule',
      title: 'Rewrite the stale rule',
      kind: 'rule',
      file: 'CLAUDE.md',
      rule: 'old',
      change: 'new',
      why: 'The audit says it is stale',
      causes: ['stale'],
      audit: { location: 'CLAUDE.md:1', finding: 'stale' },
      target: 'project-shared',
      confidence: 0.7,
    };
    expect((await lr(['retro', 'propose', id, '--body', JSON.stringify({ proposals: [proposal] })])).code).toBe(0);
    await lr(['retro', 'decide', id, 'p1', 'accepted']);
    await lr(['retro', 'finish', id]);
    await new Promise((r) => setTimeout(r, 5));

    const second = await lr(['retro', 'start', '--sources', 'audit', '--format', 'json']);
    const next = (JSON.parse(second.out) as { id: string }).id;
    const checked = await lr(['retro', 'propose', next, '--body', JSON.stringify({ proposals: [] })]);
    expect(checked.code).toBe(0);
    const shown = await lr(['retro', 'show', next]);
    expect(shown.out).toContain(
      `- ${id}/p1 Rewrite the stale rule: not measured: no data in this period from the sources it rested on`,
    );
    const p1 = await lr(['retro', 'show', id]);
    expect(p1.out).toContain('- **Source**: the audit of the setup');
    expect(p1.out).not.toContain('**Numbers**');
  });
});

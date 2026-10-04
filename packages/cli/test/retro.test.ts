import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildAnchorContext,
  recordRetroSessions,
  RetroBook,
  writeSessionReport,
  type SessionReport,
  Store,
  writeConfig,
  type Anchor,
} from '@local-review/core';
import { runCli } from '../src/cli';
import { day } from '../src/retro';

const CODE = Array.from({ length: 10 }, (_, i) => `const v${i + 1} = ${i + 1};`).join('\n');

let base: string;
let work: string;
const env = () => ({ LOCAL_REVIEW_HOME: join(base, 'machine'), HOME: join(base, 'home') });

async function lr(args: string[], stdin = '') {
  let out = '';
  let err = '';
  const code = await runCli(args, {
    cwd: work,
    env: env(),
    out: (t) => (out += t + '\n'),
    err: (t) => (err += t + '\n'),
    readStdin: async () => stdin,
    ancestors: async () => [],
  });
  return { code, out, err };
}

const anchor = (line: number): Anchor => ({
  path: 'src/a.ts',
  source: 'worktree',
  ref: null,
  sha: null,
  ...buildAnchorContext(CODE, { startLine: line, endLine: line }),
});

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'lr-retro-cli-')));
  work = join(base, 'work');
  await mkdir(work);
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** Three threads in a repository of the project: two about UTC dates, one praise. */
async function project() {
  const api = new Store(join(work, 'api'));
  const utc1 = await api.createThread(anchor(1), { author: 'user', body: 'Dates are UTC here', reviewId: null });
  await api.addComment(
    utc1.id,
    { author: 'agent', agent: 'Claude', body: 'Which zone?', reviewId: null },
    { status: 'needs-info' },
  );
  await api.addComment(utc1.id, { author: 'user', body: 'UTC, always', reviewId: null });
  const utc2 = await api.createThread(anchor(3), { author: 'user', body: 'UTC again please', reviewId: null });
  await api.addComment(
    utc2.id,
    { author: 'agent', agent: 'Claude', body: 'Done', reviewId: null },
    { status: 'addressed' },
  );
  await api.setStatus(utc2.id, 'open', 'user');
  const praise = await api.createThread(anchor(5), { author: 'user', body: 'Nice split', reviewId: null });
  return { utc1: utc1.id, utc2: utc2.id, praise: praise.id };
}

const startRetroOn = async (args: string[] = []) => {
  const started = await lr(['retro', 'start', '--format', 'json', ...args]);
  expect(started.code).toBe(0);
  return (JSON.parse(started.out) as { id: string }).id;
};
const startRetro = () => startRetroOn();

const utcProposal = (t: Awaited<ReturnType<typeof project>>, over: Record<string, unknown> = {}) => ({
  column: 'improve',
  subject: 'Dates are UTC',
  title: 'Say that dates are UTC',
  kind: 'rule',
  file: 'api/CLAUDE.md',
  change: '- Every date is UTC.',
  why: 'Two threads ask for UTC',
  causes: ['UTC not written'],
  evidence: [
    { thread: t.utc1, excerpt: 'Dates are UTC here' },
    { thread: t.utc2, excerpt: 'UTC again' },
  ],
  target: 'project-shared',
  targetEvidence: [],
  confidence: 0.8,
  ...over,
});

describe("lr retro with the agent's sessions", () => {
  const summary = {
    friction_detail: 'The user rejected the first fix of the dates.',
    brief_summary: 'Claude fixed the dates.',
  };

  it('gives them to the analysis, checks their citations, shows them and what reading them cost', async () => {
    const t = await project();
    const id = (await lr(['retro', 'start', '--all'])).out.match(/rt_\w+/)![0];
    const book = new RetroBook(work);
    await recordRetroSessions(
      book,
      id,
      'Claude Code /insights',
      [
        {
          id: 'sess-aaaaaaaa1',
          start: '2026-09-20T10:00:00.000Z',
          folder: work,
          facts: { user_interruptions: 2 },
          summary,
        },
        { id: 'sess-bbbbbbbb2', start: '2026-09-21T10:00:00.000Z', folder: work, facts: {}, summary: null },
      ],
      { costUsd: 0.7, durationMs: 53_000 },
    );
    const input = await lr(['retro', 'input', id, '--for', 'analysis']);
    expect(input.out).toContain('3 threads and 2 sessions of the agent');
    const text = await readFile(input.out.match(/Written: (.+)/)![1]!, 'utf8');
    expect(text).toContain('### Session sess-aaaaaaaa1');
    expect(text).toContain(summary.friction_detail);

    const sessionsOnly = utcProposal(t, {
      subject: 'Check the dates first',
      causes: ['no check of dates'],
      evidence: [],
      sessions: [{ session: 'sess-aaaaaaaa1', excerpt: 'rejected the first fix' }, 'sess-bbbbbbbb2'],
    });
    const invented = utcProposal(t, { sessions: [{ session: 'sess-aaaaaaaa1', excerpt: 'The user loved it' }] });
    const refused = await lr(['retro', 'propose', id, '--body', '-'], JSON.stringify({ proposals: [invented] }));
    expect(refused.code).toBe(1);
    expect(refused.out).toContain('the excerpt of session sess-aaaaaaaa1 is not in its summary');

    const recorded = await lr(
      ['retro', 'propose', id, '--body', '-'],
      JSON.stringify({ proposals: [utcProposal(t, { sessions: ['sess-aaaaaaaa1'] }), sessionsOnly] }),
    );
    expect(recorded.code).toBe(0);
    expect(recorded.out).toContain('p1 [improve] Dates are UTC: 2 threads and 1 session, target to ask');
    expect(recorded.out).toContain('p2 [improve] Check the dates first: 0 threads and 2 sessions (sessions only)');

    const shown = (await lr(['retro', 'show', id])).out;
    expect(shown).toContain(
      "The agent's sessions: 2 in this project and period, 1 with a summary; 2 proposals rest on them.",
    );
    expect(shown).toContain(`  - session sess-aaa (${day('2026-09-20T10:00:00.000Z')}): "${summary.friction_detail}"`);
    expect(shown).toContain('  - session sess-bbb (');
    expect(shown).toContain('facts only');
    expect(shown).toContain(
      "**Source**: 2 sessions of the agent (only the agent's sessions: summaries written by a model",
    );
    const next = (await lr(['retro', 'show', id, 'p2'])).out;
    expect(next).toContain("**Source**: 2 sessions of the agent. **Note**: only the agent's sessions");
    expect(next).toContain('- session sess-aaa');

    const finished = (await lr(['retro', 'finish', id])).out;
    expect(finished).toContain(
      "Reading the agent's sessions (Claude Code /insights) took 1 min and about $0.70 at the API list price " +
        '(on a subscription, tokens counted against your usage limits, not a bill).',
    );
  });
});

describe("lr retro with reports on the agent's sessions", () => {
  const report = (session: string, over: Partial<SessionReport> = {}): SessionReport => ({
    v: 1,
    session,
    agent: 'Claude Code',
    folder: work,
    start: '2026-09-22T10:00:00.000Z',
    end: '2026-09-22T11:00:00.000Z',
    covered: { lines: 40 },
    generatedAt: '2026-09-23T10:00:00.000Z',
    model: 'opus',
    run: { costUsd: 0.42, durationMs: 96_000, tokens: 163_000 },
    checks: { citedMoments: 2, unknownMoments: [] },
    analysis: {
      session_id: session,
      summary: 'The user asked for UTC dates twice. The agent kept local times.',
      outcome: 'achieved',
      signals: {
        collaboration: {
          corrections: {
            occurrences: 3,
            relevant: [{ agent: 'main', uuid: 'u-correct-1', verdict: 'The user asked for UTC again', quote: 'UTC!' }],
            not_relevant: [{ uuid: 'u-thanks', reason: 'approval' }],
          },
        },
      },
      patterns: [{ name: 'Dates', description: 'Dates come back in every session', evidence: ['u-correct-1'] }],
    },
    analytics: { counts: { typed_prompts: 7 }, agents: [{ id: 'main' }], signals: {} },
    ...over,
  });

  it('gives them to the analysis, checks the moments cited, records and shows the overview', async () => {
    const t = await project();
    const id = (await lr(['retro', 'start', '--all'])).out.match(/rt_\w+/)![0];
    const book = new RetroBook(work);
    await writeSessionReport(book, report('sess-r1'));
    await writeSessionReport(book, report('sess-r2', { start: '2026-09-24T10:00:00.000Z' }));
    await writeSessionReport(book, report('sess-old'));
    await book.record(id, [
      {
        type: 'retro.reports',
        source: 'Claude Code session records',
        sessions: [
          { id: 'sess-r1', start: '2026-09-22T10:00:00.000Z', status: 'analysed' },
          { id: 'sess-r2', start: '2026-09-24T10:00:00.000Z', status: 'reused' },
          { id: 'sess-fail', start: '2026-09-25T10:00:00.000Z', status: 'failed', reason: 'timeout' },
        ],
        costUsd: 0.42,
        durationMs: 96_000,
        tokens: 163_000,
      },
    ]);

    const input = await lr(['retro', 'input', id, '--for', 'analysis']);
    expect(input.out).toContain('3 threads and 2 reports on its sessions');
    const text = await readFile(input.out.match(/Written: (.+)/)![1]!, 'utf8');
    expect(text).toContain("## Reports on the agent's sessions (2)");
    expect(text).toContain(join(work, '.local-review', 'retros', 'sessions'));
    expect(text).toContain('### Session sess-r1');
    expect(text).toContain('The user asked for UTC again');
    expect(text).not.toContain('u-thanks'); // the signals judged not relevant are left out
    expect(text).not.toContain('sess-old'); // not a session of this retro

    const withMoments = (moments: string[], excerpt = 'The agent kept local times') =>
      utcProposal(t, { sessions: [{ session: 'sess-r1', excerpt, moments }] });
    const unknown = await lr(
      ['retro', 'check', id, '--body', '-'],
      JSON.stringify({ proposals: [withMoments(['u-invented'])] }),
    );
    expect(unknown.code).toBe(1);
    expect(unknown.out).toContain('moment(s) u-invented not in its report');
    const invented = await lr(
      ['retro', 'check', id, '--body', '-'],
      JSON.stringify({ proposals: [withMoments(['u-correct-1'], 'The agent loved UTC')] }),
    );
    expect(invented.out).toContain('is not in its summary or report');

    const recorded = await lr(
      ['retro', 'propose', id, '--body', '-'],
      JSON.stringify({
        proposals: [withMoments(['u-correct-1'])],
        overview: {
          summary: 'Dates come back in most sessions.',
          items: [
            {
              kind: 'friction',
              title: 'Local times',
              description: 'The agent keeps local times.',
              sessions: ['sess-r1', 'sess-r2', 'sess-unknown'],
              idea: 'A hook that checks the dates',
            },
            { kind: 'ritual', title: 'Nowhere', description: 'Only in other sessions', sessions: ['sess-old'] },
          ],
        },
      }),
    );
    expect(recorded.code).toBe(0);
    expect(recorded.out).toContain('overview of the sessions: 1 item(s)');
    expect(recorded.out).toContain('session sess-unknown is not one the retro reads, left out');

    const state = await book.get(id);
    expect(state.proposals[0]!.sessions).toEqual([
      {
        session: 'sess-r1',
        start: '2026-09-22T10:00:00.000Z',
        excerpt: 'The agent kept local times',
        moments: ['u-correct-1'],
      },
    ]);
    expect(state.overview?.items).toEqual([
      {
        kind: 'friction',
        title: 'Local times',
        description: 'The agent keeps local times.',
        sessions: ['sess-r1', 'sess-r2'],
        idea: 'A hook that checks the dates',
      },
    ]);

    const shown = (await lr(['retro', 'show', id])).out;
    expect(shown).toContain(
      "Reports on the agent's sessions: 2 (1 written for this retro, 1 kept from before), 1 could not be written; 1 proposal points at moments of them.",
    );
    expect(shown).toContain('## Your sessions with the agent: what recurs');
    expect(shown).toContain(
      '- **Friction: Local times** (2 sessions: sess-r1, sess-r2). The agent keeps local times. Lead: A hook that checks the dates',
    );
    expect(shown).toContain('"The agent kept local times" (moment u-correc)');
    const json = JSON.parse((await lr(['retro', 'show', id, '--format', 'json'])).out);
    expect(json.overview.summary).toBe('Dates come back in most sessions.');

    const finished = (await lr(['retro', 'finish', id])).out;
    expect(finished).toContain(
      "Reports on the agent's sessions: 1 written (1 kept from earlier retros, at no cost), in 2 min, 163 k tokens, " +
        'about $0.42 at the API list price (on a subscription, tokens counted against your usage limits, not a bill).',
    );
  });

  it('cites a session by its report alone: its first sentence is shown', async () => {
    const t = await project();
    const id = (await lr(['retro', 'start', '--all'])).out.match(/rt_\w+/)![0];
    const book = new RetroBook(work);
    await writeSessionReport(book, report('sess-r1'));
    await book.record(id, [
      {
        type: 'retro.reports',
        source: 'Claude Code session records',
        sessions: [{ id: 'sess-r1', start: '2026-09-22T10:00:00.000Z', status: 'analysed' }],
      },
    ]);
    const recorded = await lr(
      ['retro', 'propose', id, '--body', '-'],
      JSON.stringify({ proposals: [utcProposal(t, { sessions: ['sess-r1'] })] }),
    );
    expect(recorded.code).toBe(0);
    expect((await book.get(id)).proposals[0]!.sessions![0]!.excerpt).toBe('The user asked for UTC dates twice.');
  });
});

describe('lr retro', () => {
  it('announces the scope of a first retro, with periods to choose from', async () => {
    await project();
    const { code, out } = await lr(['retro', 'scope']);
    expect(code).toBe(0);
    expect(out).toContain(`# Retro scope — ${work}`);
    expect(out).toContain('proposed for a first retro');
    expect(out).toContain('**Threads**: 3 (3 open, 0 needs-info');
    expect(out).toContain('- api (below): 3 threads');
    expect(out).toContain('## Periods to choose from');
    expect(out).toContain('- last 7 days (--since 7d, proposed): 3 threads');
    expect(out).toContain('- whole history (--all): 3 threads');
    expect(out).not.toContain('reads again threads of the last retro');
    expect(out).toContain('None: this would be the first retro of this project.');
    expect(out).toMatch(/\*\*Time\*\* \(estimate\): classification \d+ min with Jev/);
    const json = JSON.parse((await lr(['retro', 'scope', '--format', 'json', '--all'])).out);
    expect(json).toMatchObject({ source: 'all', threads: 3, stores: [{ origin: 'below', threads: 3 }] });
    expect((await lr(['retro', 'scope', '--since', '2020-01-01'])).out).toContain('since 2020-01-01 00:00');
    expect((await lr(['retro', 'scope', '--since', '7d', '--all'])).code).toBe(1);
    expect(out).not.toContain('**History**');
    expect(json.keepHistory).toBe(true);
  });

  it('says in its scope when deleted threads are not kept', async () => {
    await project();
    await writeConfig({ keepHistory: false }, env());
    expect((await lr(['retro', 'scope'])).out).toContain(
      '- **History**: not kept on this machine (keep-history is off): deleted threads are erased, so this retro does not see them.',
    );
    expect(JSON.parse((await lr(['retro', 'scope', '--format', 'json'])).out).keepHistory).toBe(false);
  });

  it('runs a whole retro: start, classify, propose, decide, apply, finish', async () => {
    const t = await project();
    const id = await startRetro();
    expect((await lr(['retro', 'feedback', id, '--body', '-'], 'It helped')).out).toContain('Feedback recorded');

    const input = await lr(['retro', 'input', id, '--for', 'analysis']);
    expect(input.out).toContain('3 threads');
    const file = input.out.split('\n')[0]!.replace('Written: ', '');
    expect(file).toBe(join(work, '.local-review', 'retros', id, 'analysis-input.md'));
    expect(await readFile(file, 'utf8')).toContain('UTC again please');
    expect(input.out).toContain(
      `Then write your JSON in ${join(work, '.local-review', 'retros', id, 'proposals.json')} and run: lr retro check ${id} --root ${work}`,
    );
    expect((await lr(['retro', 'input', id, '--for', 'classify', '--format', 'json'])).out).toContain(
      'classify-input.md',
    );
    expect((await lr(['retro', 'input', id, '--for', 'nothing'])).code).toBe(1);

    const labels = {
      labels: [
        { thread: t.utc1, category: 3, confidence: 0.9, missingRule: 0.8, ignoredRule: 0.1 },
        { thread: t.utc2, category: 3 },
        { thread: 't_nope', category: 3 },
        { thread: t.praise, category: 99 },
      ],
    };
    const classified = await lr(
      ['retro', 'classification', id, '--by', 'haiku', '--body', '-'],
      JSON.stringify(labels),
    );
    expect(classified.out).toContain('Recorded 2 labels (2/3 threads classified).');
    expect(classified.out).toContain('Skipped t_nope: not a thread of this retro');
    expect(classified.out).toContain('category must be 1 to 14');
    expect((await lr(['retro', 'classification', id, '--body', '{}'])).code).toBe(1);
    expect((await lr(['retro', 'classification', id, '--by', 'x', '--body', '{"labels":[]}'])).err).toContain(
      'no valid label',
    );
    expect((await lr(['retro', 'classification', id, '--by', 'x', '--body', 'not json'])).err).toContain(
      'invalid JSON',
    );

    const bad = { proposals: [utcProposal(t, { causes: ['a', 'b'] })] };
    const rejected = await lr(['retro', 'propose', id, '--body', '-'], JSON.stringify(bad));
    expect(rejected.code).toBe(1);
    expect(rejected.out).toContain('REJECTED #1 Dates are UTC: one subject per proposal');
    expect(rejected.out).toContain('nothing was recorded');

    const good = {
      proposals: [utcProposal(t)],
      watch: [
        { subject: 'Small components', why: 'praised once', evidence: [{ thread: t.praise, excerpt: 'Nice split' }] },
      ],
    };
    await writeFile(join(base, 'proposals.json'), JSON.stringify(good));
    const checked = await lr(['retro', 'check', id, '--body-file', join(base, 'proposals.json')]);
    expect(checked.code).toBe(0);
    expect(checked.out).toContain('The guard rails pass: 1 proposals, 1 to watch');
    expect(checked.out).toContain('p1 [improve] Dates are UTC: 2 threads, target to ask');
    expect(
      JSON.parse((await lr(['retro', 'check', id, '--format', 'json', '--body', JSON.stringify(good)])).out).recorded,
    ).toBe(false);
    expect((await lr(['retro', 'propose', id, '--body-file', join(base, 'proposals.json')])).out).toContain(
      'Recorded: 1 proposals',
    );

    const shown = (await lr(['retro', 'show', id])).out;
    expect(shown).toContain('## To improve');
    expect(shown).toContain('### p1 · To improve · Say that dates are UTC');
    expect(shown).toContain(`- ${t.utc1} (src/a.ts:1, open): "Dates are UTC here"`);
    expect(shown).toContain(
      '**Numbers**: 2 threads, 1 reopened, 1 with a question from the agent, 1 round(s) of back-and-forth',
    );
    expect(shown).toContain('**File**: api/CLAUDE.md');
    expect(shown).toContain('**Why**: Two threads ask for UTC');
    expect(shown).toContain('**Target**: to ask the user');
    expect(shown).toContain('**Confidence**: 80%');
    expect(shown).toContain('## To watch (seen in a single thread or session)');
    expect(shown).toContain('classified by haiku');
    expect(JSON.parse((await lr(['retro', 'show', id, '--format', 'json'])).out).stats).toMatchObject({
      threads: 3,
      reopened: 1,
    });

    expect((await lr(['retro', 'decide', id, 'p9', 'accepted'])).err).toContain('Proposal not found');
    expect((await lr(['retro', 'decide', id, 'p1', 'maybe'])).code).toBe(1);
    expect((await lr(['retro', 'decide', id, 'p1', 'retarget'])).err).toContain('retargeted needs --target');
    expect((await lr(['retro', 'decide', id, 'p1', 'accept', '--target', 'team'])).code).toBe(1);
    expect((await lr(['retro', 'applied', id, 'p1', '--file', 'x'])).err).toContain('was not accepted');
    expect(
      (await lr(['retro', 'decide', id, 'p1', 'retarget', '--target', 'project-personal', '--note', 'mine'])).out,
    ).toBe('p1 retargeted (project-personal).\n');
    expect((await lr(['retro', 'applied', id, 'p1'])).code).toBe(1);
    expect((await lr(['retro', 'applied', id, 'p2', '--file', 'x'])).code).toBe(2);
    expect((await lr(['retro', 'applied', id, 'p1', '--file', 'api/CLAUDE.local.md'])).out).toContain('1 file(s)');

    const finished = await lr(['retro', 'finish', id]);
    expect(finished.out).toContain('0 accepted, 0 modified, 1 with another target, 0 excluded');
    expect(finished.out).toContain(`Files changed (1):\n- ${join(work, 'api', 'CLAUDE.local.md')}`);
    expect(finished.out).toContain('To watch:\n- Small components');
    expect((await lr(['retro', 'finish', id])).err).toContain('is finished');
    expect((await lr(['retro', 'list'])).out).toContain(`${id} · ${work}`);
    expect(JSON.parse((await lr(['retro', 'list', '--format', 'json'])).out)[0]).toMatchObject({ id, proposals: 1 });

    // The next retro starts from this one, and says what it decided.
    const next = (await lr(['retro', 'scope'])).out;
    expect(next).toContain('since the last retro');
    expect(next).toContain(
      `- p1 [To improve] Say that dates are UTC: retargeted (project-personal) → ${join(work, 'api', 'CLAUDE.local.md')}`,
    );
    expect((await lr(['retro', 'start'])).err).toContain('no thread in this period');
  });

  it('presents one proposal at a time, in the order of the discussion, always in the same parts', async () => {
    const t = await project();
    const id = await startRetro();
    const proposals = {
      proposals: [
        utcProposal(t, {
          column: 'keep',
          subject: 'Small modules',
          title: 'Keep the small-modules rule',
          rule: '- Keep modules small.',
          change: '',
          targetWhy: 'it is in the team file',
        }),
        utcProposal(t, { change: '- Every date is UTC.\n- APIs return ISO 8601 strings.' }),
        utcProposal(t, {
          column: 'remove',
          subject: 'Tabs or spaces',
          title: 'Remove the tabs rule',
          rule: '- Always use tabs.',
          change: 'Delete the line.',
          evidence: [],
          audit: { location: 'api/CLAUDE.md:2-3', finding: 'Contradicts "always 2 spaces"' },
          targetEvidence: [t.utc1],
        }),
      ],
    };
    expect((await lr(['retro', 'propose', id, '--body', '-'], JSON.stringify(proposals))).code).toBe(0);

    const first = (await lr(['retro', 'show', id, '--next'])).out;
    expect(first.startsWith('---\n\n## Proposal 1/3 (p2) · To improve · Say that dates are UTC\n')).toBe(true);
    expect(first).toContain(`**Source**: 2 threads\n- ${t.utc1} (src/a.ts:1, open): "Dates are UTC here"`);
    expect(first).toContain('**Numbers**: 2 threads, 1 reopened');
    expect(first).toContain('**File**: `api/CLAUDE.md` (rule)');
    expect(first).toContain('**Proposed change**:\n> - Every date is UTC.\n> - APIs return ISO 8601 strings.');
    expect(first).toContain('**Target**: to choose (nothing in the threads tells it). Suggested: project, shared');
    expect(first).toContain('**Confidence**: 80% · recommended: accepted');
    expect(first).not.toContain('**Existing rule**');

    await lr(['retro', 'decide', id, 'p2', 'accepted']);
    const second = (await lr(['retro', 'show', id, '--next'])).out;
    expect(second).toContain('## Proposal 2/3 (p3) · To remove · Remove the tabs rule');
    expect(second).toContain(
      '**Source**: 0 threads, and the audit of your setup (/doctor prompt-audit)\n- /doctor prompt-audit, `api/CLAUDE.md:2-3`: Contradicts "always 2 spaces"',
    );
    expect(second).not.toContain('**Numbers**');
    expect(second).toContain('**Existing rule**:\n> - Always use tabs.');
    expect((await lr(['retro', 'show', id])).out).toContain(
      '- **Source**: 0 threads, and the audit of the setup\n  - /doctor prompt-audit, api/CLAUDE.md:2-3',
    );

    const kept = (await lr(['retro', 'show', id, 'p1'])).out;
    expect(kept).toContain('## Proposal 3/3 (p1) · To keep · Keep the small-modules rule');
    expect(kept).not.toContain('**Proposed change**');
    expect(JSON.parse((await lr(['retro', 'show', id, 'p2', '--format', 'json'])).out)).toMatchObject({
      position: 1,
      total: 3,
      decision: { decision: 'accepted' },
    });
    expect((await lr(['retro', 'show', id, 'p2'])).out).toContain('**Decision**: accepted');
    expect((await lr(['retro', 'show', id, 'p9'])).err).toContain('Proposal not found: p9');

    // A decision recorded on the wrong proposal is undone, with its files, never edited by hand.
    await lr(['retro', 'decide', id, 'p1', 'accepted']);
    await lr(['retro', 'applied', id, 'p1', '--file', 'api/CLAUDE.md']);
    expect((await lr(['retro', 'undo', id, 'p1'])).out).toBe(
      `p1: decision "accepted" undone, and its files changed forgotten (${join(work, 'api', 'CLAUDE.md')}): undo those changes if they were not for it.\n`,
    );
    expect((await lr(['retro', 'undo', id, 'p1'])).err).toContain('p1 has no decision to undo');
    expect((await lr(['retro', 'undo', id, 'p9'])).err).toContain('Proposal not found: p9');
    expect((await lr(['retro', 'undo', id, 'p2'])).out).toBe('p2: decision "accepted" undone.\n');
    expect((await lr(['retro', 'show', id, '--next'])).out).toContain('## Proposal 1/3 (p2)');
    await lr(['retro', 'decide', id, 'p2', 'accepted']);
    await lr(['retro', 'decide', id, 'p3', 'excluded', '--note', 'not now']);
    await lr(['retro', 'decide', id, 'p1', 'accepted']);
    expect((await lr(['retro', 'show', id, '--next'])).out).toBe('All 3 proposals are decided.\n');
    expect(JSON.parse((await lr(['retro', 'show', id, '--format', 'json'])).out).applied).toEqual({});
    await lr(['retro', 'finish', id]);
    expect((await lr(['retro', 'undo', id, 'p1'])).err).toContain('is finished');
  });

  it('says when no proposal is recorded yet', async () => {
    await project();
    const id = await startRetro();
    expect((await lr(['retro', 'show', id, '--next'])).out).toBe('No proposal recorded yet.\n');
  });

  it('does not propose again a subject the user excluded, unless new threads raise it', async () => {
    const t = await project();
    const first = await startRetro();
    await lr(['retro', 'propose', first, '--body', JSON.stringify({ proposals: [utcProposal(t)] })]);
    await lr(['retro', 'decide', first, 'p1', 'exclude', '--note', 'not a rule']);
    expect((await lr(['retro', 'finish', first])).out).toContain('1 excluded');
    await new Promise((r) => setTimeout(r, 5));

    const second = await startRetro().catch(() => null);
    expect(second).toBeNull(); // nothing new since
    const api = new Store(join(work, 'api'));
    await api.addComment(t.utc1, { author: 'user', body: 'And here', reviewId: null });
    const id = (JSON.parse((await lr(['retro', 'start', '--all', '--format', 'json'])).out) as { id: string }).id;
    const again = await lr(['retro', 'propose', id, '--body', JSON.stringify({ proposals: [utcProposal(t)] })]);
    expect(again.out).toContain('left out: Dates are UTC (you excluded "Dates are UTC"');
    expect((await lr(['retro', 'show', id])).out).toContain('## Left out by the guard rails');
    const analysis = await readFile(join(work, '.local-review', 'retros', id, 'analysis-input.md'), 'utf8').catch(
      () => '',
    );
    expect(analysis).toBe('');
    expect((await lr(['retro', 'input', id, '--for', 'analysis'])).code).toBe(0);
    expect(await readFile(join(work, '.local-review', 'retros', id, 'analysis-input.md'), 'utf8')).toContain(
      `${first}/p1: Dates are UTC (excluded`,
    );

    // Two new threads raise it again: it comes back, and says so.
    const n1 = await api.createThread(anchor(7), { author: 'user', body: 'UTC, still', reviewId: null });
    const n2 = await api.createThread(anchor(9), { author: 'user', body: 'UTC once more', reviewId: null });
    const third = (JSON.parse((await lr(['retro', 'start', '--all', '--format', 'json'])).out) as { id: string }).id;
    const back = utcProposal(t, {
      evidence: [
        { thread: n1.id, excerpt: 'UTC, still' },
        { thread: n2.id, excerpt: 'UTC once more' },
      ],
      reopens: `${first}/p1`,
    });
    expect((await lr(['retro', 'propose', third, '--body', JSON.stringify({ proposals: [back] })])).code).toBe(0);
    expect((await lr(['retro', 'show', third, '--next'])).out).toContain(
      `**Excluded before** (${day((await new RetroBook(work).get(first)).decisions.p1!.at)}), back for new threads: ${n1.id}, ${n2.id}.`,
    );
  });

  it('keeps the retro preferences of the project', async () => {
    expect((await lr(['retro', 'prefs'])).out).toBe('No retro preference yet.\n');
    expect((await lr(['retro', 'prefs', 'add', '--body', '-'], 'At most 5 proposals\n')).out).toBe(
      'Preference P1 saved: At most 5 proposals\n',
    );
    await lr(['retro', 'prefs', 'add', '--body', 'Ignore formatting']);
    expect((await lr(['retro', 'prefs'])).out).toBe('P1: At most 5 proposals\nP2: Ignore formatting\n');
    expect((await lr(['retro', 'prefs', 'remove', 'P1'])).out).toBe('Preference P1 removed.\n');
    expect((await lr(['retro', 'prefs', 'remove'])).code).toBe(1);
    expect((await lr(['retro', 'prefs', 'remove', 'P7'])).code).toBe(2);
    expect((await lr(['retro', 'prefs', 'rename'])).code).toBe(1);
    expect(JSON.parse((await lr(['retro', 'prefs', '--format', 'json'])).out)).toMatchObject([{ id: 'P2' }]);
    expect((await lr(['retro', 'scope'])).out).toContain('- P2: Ignore formatting');
    expect(await new RetroBook(work).preferences()).toHaveLength(1);
  });

  it('checks the Jev key without reading it', async () => {
    const none = (await lr(['retro', 'key'])).out;
    expect(none).toContain('Jev: no key (expected in');
    expect(none).toContain('in their own terminal');
    expect(none).toContain("sh -c 'umask 077");
    const file = join(base, 'home', '.config', 'local-review', 'jev-key');
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, 'top-secret-key\n');
    await chmod(file, 0o644);
    const open = await lr(['retro', 'key']);
    expect(open.out).toContain('mode 644: others can read it');
    expect(open.out).toContain(`chmod 600 "${file}"`);
    expect(open.out).not.toContain('top-secret-key');
    await chmod(file, 0o600);
    expect((await lr(['retro', 'key'])).out).toContain('only you can read it, in no repository). Ready.');
    const json = JSON.parse((await lr(['retro', 'key', '--format', 'json'])).out);
    expect(json).toMatchObject({ ok: true, source: 'file' });
    expect(JSON.stringify(json)).not.toContain('top-secret-key');
  });

  it('explains its mistakes', async () => {
    expect((await lr(['retro'])).err).toContain('unknown retro action: (none)');
    expect((await lr(['retro', 'show'])).err).toContain('missing <retro-id>');
    expect((await lr(['retro', 'show', 'rt_00000000000000000000000000'])).code).toBe(2);
    expect((await lr(['retro', 'feedback', 'rt_00000000000000000000000000'])).code).toBe(2);
    expect((await lr(['retro', 'start'])).err).toContain('no thread in this period');
    expect((await lr(['help'])).out).toContain('lr retro scope');
  });

  it('shows unfinished retros, decisions, guard-rail notes and missing threads', async () => {
    const t = await project();
    await lr(['retro', 'prefs', 'add', '--body', 'Short please']);
    expect((await lr(['retro', 'list'])).out).toBe('No retro yet in this project.\n');
    const started = await lr(['retro', 'start', '--all']);
    expect(started.out).toMatch(/^Retro rt_\w+ started: 3 threads, .* the start to /);
    const id = started.out.split(' ')[1]!;
    expect((await lr(['retro', 'scope', '--all'])).out).toContain(`## Unfinished retros\n\n- ${id}, started`);
    expect((await lr(['retro', 'scope', '--all'])).out).toContain('the whole history, until now');

    // Labels keyed by thread are accepted too.
    expect(
      (
        await lr([
          'retro',
          'classification',
          id,
          '--by',
          'jev',
          '--body',
          JSON.stringify({ [t.utc1]: { category: 2 } }),
        ])
      ).out,
    ).toContain('Recorded 1 labels');
    const keep = utcProposal(t, {
      column: 'keep',
      subject: 'Keep the UTC rule',
      rule: 'Dates are UTC.',
      change: '',
      evidence: [t.utc1, t.utc2, 't_elsewhere'],
    });
    const rejected = await lr([
      'retro',
      'check',
      id,
      '--format',
      'json',
      '--body',
      JSON.stringify({ proposals: [{}] }),
    ]);
    expect(rejected.code).toBe(1);
    expect(JSON.parse(rejected.out).rejected[0].reasons.length).toBeGreaterThan(3);
    expect((await lr(['retro', 'check', id, '--body', '{'])).err).toContain('invalid JSON');
    expect((await lr(['retro', 'check', id])).err).toContain('needs --body');
    const recorded = await lr(['retro', 'propose', id, '--body', JSON.stringify({ proposals: [keep] })]);
    expect(recorded.out).toContain('turned from keep into improve');
    expect(recorded.out).toContain('note: Keep the UTC rule: thread t_elsewhere is not in the period');
    await lr(['retro', 'decide', id, 'p1', 'modified', '--note', 'shorter']);
    const shown = (await lr(['retro', 'show', id])).out;
    expect(shown).toContain('Preferences: P1 Short please');
    expect(shown).toContain(`- ${t.utc1} (src/a.ts:1, open)\n`);
    expect(shown).toContain('**Rule**: Dates are UTC.');
    expect(shown).toContain('**Guard rail**: proposed as "keep", but you had to enforce the rule in');
    expect(shown).toContain('**Decision**: modified: shorter');
    expect(shown).toContain('**Target**: project, shared (committed, for the team)');
    const one = (await lr(['retro', 'show', id, 'p1'])).out;
    expect(one).toContain('**Existing rule**:\n> Dates are UTC.');
    expect(one).toContain('**Guard rail**: proposed as "keep", but you had to enforce the rule in');
    expect(one).toContain('**Decision**: modified: shorter');

    // A thread whose journal is gone is reported, not invented.
    await rm(join(work, 'api', '.local-review', 'threads', `${t.praise}.jsonl`));
    expect((await lr(['retro', 'input', id, '--for', 'classify'])).out).toContain(
      `1 thread(s) of the retro are no longer found: ${t.praise}`,
    );
    const finished = await lr(['retro', 'finish', id, '--format', 'json']);
    expect(JSON.parse(finished.out)).toMatchObject({ files: [], undecided: [] });
    const empty = await startRetroOn(['--all']);
    // The change adopted at the first retro must be checked: here, no thread raises its subject again.
    const unchecked = await lr(['retro', 'propose', empty, '--body', JSON.stringify({ proposals: [utcProposal(t)] })]);
    expect(unchecked.code).toBe(1);
    expect(unchecked.out).toContain(`REJECTED check of ${id}/p1: "verify" must check`);
    const verify = [{ change: `${id}/p1`, threads: [] }];
    await lr(['retro', 'propose', empty, '--body', JSON.stringify({ proposals: [utcProposal(t)], verify })]);
    expect((await lr(['retro', 'finish', empty])).out).toContain('1 without a decision (p1)');
    expect((await lr(['retro', 'scope', '--since', '2020-01-01'])).out).toContain(
      '- p1 [To improve] Say that dates are UTC: no decision',
    );
  });

  it('says where a key from the environment, or a key in a repository, stands', async () => {
    let out = '';
    await runCli(['retro', 'key'], {
      cwd: work,
      env: { ...env(), JEV_API_KEY: 'k' },
      out: (t) => (out += t),
      err: () => undefined,
      readStdin: async () => '',
    });
    expect(out).toBe('Jev: the key comes from $JEV_API_KEY. Ready.');
    const file = join(base, 'home', '.config', 'local-review', 'jev-key');
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, 'k');
    await chmod(file, 0o600);
    execFileSync('git', ['init', '-q'], { cwd: join(base, 'home') });
    const inRepo = (await lr(['retro', 'key'])).out;
    expect(inRepo).toContain(`(inside the repository ${join(base, 'home')})`);
    expect(inRepo).toContain('move it out of the repository');
  });

  it('shows dates in local time', () => {
    expect(day(null)).toBe('the start');
    const d = new Date(2026, 9, 3, 7, 5);
    expect(day(d.toISOString())).toBe('2026-10-03 07:05');
  });
});

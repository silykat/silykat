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
} from '@silykat/core';
import { runCli } from '../src/cli';
import { day } from '../src/retro';

const CODE = Array.from({ length: 10 }, (_, i) => `const v${i + 1} = ${i + 1};`).join('\n');

let base: string;
let work: string;
const env = () => ({ SILYKAT_HOME: join(base, 'machine'), HOME: join(base, 'home') });

async function slk(args: string[], stdin = '') {
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
  base = await realpath(await mkdtemp(join(tmpdir(), 'slk-retro-cli-')));
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
  const started = await slk(['retro', 'start', '--format', 'json', ...args]);
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

describe("slk retro with the agent's sessions", () => {
  const summary = {
    friction_detail: 'The user rejected the first fix of the dates.',
    brief_summary: 'Claude fixed the dates.',
  };

  it('gives them to the analysis, checks their citations, shows them and what reading them cost', async () => {
    const t = await project();
    await slk(['config', 'set', 'retro-sessions', 'insights']);
    const id = (await slk(['retro', 'start', '--all'])).out.match(/rt_\w+/)![0];
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
    const input = await slk(['retro', 'input', id, '--for', 'analysis']);
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
    const refused = await slk(['retro', 'propose', id, '--body', '-'], JSON.stringify({ proposals: [invented] }));
    expect(refused.code).toBe(1);
    expect(refused.out).toContain('the excerpt of session sess-aaaaaaaa1 is not in its summary');

    const recorded = await slk(
      ['retro', 'propose', id, '--body', '-'],
      JSON.stringify({ proposals: [utcProposal(t, { sessions: ['sess-aaaaaaaa1'] }), sessionsOnly] }),
    );
    expect(recorded.code).toBe(0);
    expect(recorded.out).toContain('p1 [improve] Dates are UTC: 2 threads and 1 session, target to ask');
    expect(recorded.out).toContain('p2 [improve] Check the dates first: 0 threads and 2 sessions (sessions only)');

    const shown = (await slk(['retro', 'show', id])).out;
    expect(shown).toContain(
      "The agent's sessions: 2 in this project and period, 1 with a summary; 2 proposals rest on them.",
    );
    expect(shown).toContain(`  - session sess-aaa (${day('2026-09-20T10:00:00.000Z')}): "${summary.friction_detail}"`);
    expect(shown).toContain('  - session sess-bbb (');
    expect(shown).toContain('facts only');
    expect(shown).toContain(
      "**Source**: 2 sessions of the agent (only the agent's sessions: summaries written by a model",
    );
    const next = (await slk(['retro', 'show', id, 'p2'])).out;
    expect(next).toContain("**Source**: 2 sessions of the agent. **Note**: only the agent's sessions");
    expect(next).toContain('- session sess-aaa');

    const finished = (await slk(['retro', 'finish', id])).out;
    expect(finished).toContain(
      "Reading the agent's sessions (Claude Code /insights) took 1 min and about $0.70 at the API list price " +
        '(on a subscription, tokens counted against your usage limits, not a bill).',
    );
  });
});

describe("slk retro with reports on the agent's sessions", () => {
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
    const id = (await slk(['retro', 'start', '--all'])).out.match(/rt_\w+/)![0];
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

    const input = await slk(['retro', 'input', id, '--for', 'analysis']);
    expect(input.out).toContain('3 threads and 2 reports on its sessions');
    const text = await readFile(input.out.match(/Written: (.+)/)![1]!, 'utf8');
    expect(text).toContain("## Reports on the agent's sessions (2)");
    expect(text).toContain(join(work, '.silykat', 'retros', 'sessions'));
    expect(text).toContain('### Session sess-r1');
    expect(text).toContain('The user asked for UTC again');
    expect(text).not.toContain('u-thanks'); // the signals judged not relevant are left out
    expect(text).not.toContain('sess-old'); // not a session of this retro

    const withMoments = (moments: string[], excerpt = 'The agent kept local times') =>
      utcProposal(t, { sessions: [{ session: 'sess-r1', excerpt, moments }] });
    const unknown = await slk(
      ['retro', 'check', id, '--body', '-'],
      JSON.stringify({ proposals: [withMoments(['u-invented'])] }),
    );
    expect(unknown.code).toBe(1);
    expect(unknown.out).toContain('moment(s) u-invented not in its report');
    const invented = await slk(
      ['retro', 'check', id, '--body', '-'],
      JSON.stringify({ proposals: [withMoments(['u-correct-1'], 'The agent loved UTC')] }),
    );
    expect(invented.out).toContain('is not in its summary or report');

    const recorded = await slk(
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

    const shown = (await slk(['retro', 'show', id])).out;
    expect(shown).toContain(
      "Reports on the agent's sessions: 2 (1 written for this retro, 1 kept from before), 1 could not be written; 1 proposal points at moments of them.",
    );
    expect(shown).toContain('## Your sessions with the agent: what recurs');
    expect(shown).toContain(
      '- **Friction: Local times** (2 sessions: sess-r1, sess-r2). The agent keeps local times. Lead: A hook that checks the dates',
    );
    expect(shown).toContain('"The agent kept local times" (moment u-correc)');
    const json = JSON.parse((await slk(['retro', 'show', id, '--format', 'json'])).out);
    expect(json.overview.summary).toBe('Dates come back in most sessions.');

    const finished = (await slk(['retro', 'finish', id])).out;
    expect(finished).toContain(
      "Reports on the agent's sessions: 1 written (1 kept from earlier retros, at no cost), in 2 min, 163 k tokens, " +
        'about $0.42 at the API list price (on a subscription, tokens counted against your usage limits, not a bill).',
    );
  });

  it('cites a session by its report alone: its first sentence is shown', async () => {
    const t = await project();
    const id = (await slk(['retro', 'start', '--all'])).out.match(/rt_\w+/)![0];
    const book = new RetroBook(work);
    await writeSessionReport(book, report('sess-r1'));
    await book.record(id, [
      {
        type: 'retro.reports',
        source: 'Claude Code session records',
        sessions: [{ id: 'sess-r1', start: '2026-09-22T10:00:00.000Z', status: 'analysed' }],
      },
    ]);
    const recorded = await slk(
      ['retro', 'propose', id, '--body', '-'],
      JSON.stringify({ proposals: [utcProposal(t, { sessions: ['sess-r1'] })] }),
    );
    expect(recorded.code).toBe(0);
    expect((await book.get(id)).proposals[0]!.sessions![0]!.excerpt).toBe('The user asked for UTC dates twice.');
  });
});

describe('slk retro, one source at a time', () => {
  it('reads the sessions one way only, as set when the retro starts', async () => {
    await project();
    expect((await slk(['retro', 'scope'])).out).toContain(
      "- **The agent's sessions**: read through a report on each session, written by a model",
    );
    const id = (await slk(['retro', 'start', '--all'])).out.match(/rt_\w+/)![0];
    expect((await new RetroBook(work).get(id)).sessionsMode).toBe('reports');
    // Sessions found by /insights are not read by a retro that reads the reports.
    await recordRetroSessions(new RetroBook(work), id, 'Claude Code /insights', [
      { id: 'sess-i', start: '2026-09-20T10:00:00.000Z', folder: work, facts: {}, summary: { brief_summary: 'x' } },
    ]);
    const input = await slk(['retro', 'input', id, '--for', 'analysis']);
    expect(input.out).toContain('Written: ');
    expect(await readFile(input.out.match(/Written: (.+)/)![1]!, 'utf8')).not.toContain('sess-i');
    await slk(['config', 'set', 'retro-sessions', 'insights']);
    expect((await slk(['retro', 'scope'])).out).toContain("read through the agent's own summaries of them");
  });

  it('gives each source to its own agent, records their findings, then gives them all to the analysis', async () => {
    const t = await project();
    const id = (await slk(['retro', 'start', '--all'])).out.match(/rt_\w+/)![0];
    const book = new RetroBook(work);
    await book.record(id, [
      {
        type: 'retro.usage',
        source: 'Claude Code',
        tools: [
          {
            kind: 'skill',
            name: 'dates',
            scope: 'project',
            file: join(work, '.claude', 'skills', 'dates', 'SKILL.md'),
            path: join(work, '.claude', 'skills', 'dates'),
            byUser: 0,
            byAgent: 0,
            sessions: 0,
            lastUsed: null,
          },
        ],
        windows: [{ scope: 'project', sessions: 5, since: '2026-09-01T10:00:00.000Z', keptDays: 30 }],
      },
    ]);
    const noAudit = await slk(['retro', 'input', id, '--for', 'audit']);
    expect(await readFile(noAudit.out.match(/Written: (.+)/)![1]!, 'utf8')).toContain('None: the audit did not run.');
    expect((await slk(['retro', 'input', id, '--for', 'sessions'])).out).toContain('nothing to read');
    await writeFile(join(await book.workDir(id), 'audit.md'), '# Audit\nThe dates skill is stale.\n');

    const threads = await slk(['retro', 'input', id, '--for', 'threads']);
    expect(threads.out).toContain('3 threads');
    expect(threads.out).toContain(`slk retro findings ${id} --root ${work} --source threads --body-file `);
    expect(threads.out).toContain('findings-threads.json');
    const audit = await slk(['retro', 'input', id, '--for', 'audit']);
    expect(audit.out).toContain('the audit of the setup and the usage of its tools');
    const auditText = await readFile(audit.out.match(/Written: (.+)/)![1]!, 'utf8');
    expect(auditText).toContain('The dates skill is stale.');
    expect(auditText).toContain('NEVER USED');
    expect((await slk(['retro', 'input', id, '--for', 'nope'])).err).toContain(
      '--for must be one of classify, analysis, threads, sessions, audit',
    );

    const rejected = await slk(
      ['retro', 'findings', id, '--source', 'threads', '--body', '-'],
      JSON.stringify({ findings: [{ subject: 'Dates', evidence: [t.utc1], confidence: 0.9 }] }),
    );
    expect(rejected.code).toBe(1);
    expect(rejected.out).toContain('1 finding(s) rejected: fix them, nothing was recorded.');
    expect(rejected.out).toContain('"cause" is missing');
    expect((await slk(['retro', 'findings', id, '--source', 'code', '--body', '{}'])).err).toContain(
      '--source must be one of threads, sessions, audit',
    );
    const recorded = await slk(
      ['retro', 'findings', id, '--source', 'threads', '--body', '-'],
      JSON.stringify({
        findings: [
          {
            subject: 'Dates',
            cause: 'UTC not written',
            evidence: [{ thread: t.utc1, excerpt: 'Dates are UTC here' }, t.utc2, 't_gone'],
            confidence: 0.9,
          },
        ],
      }),
    );
    expect(recorded.code).toBe(0);
    expect(recorded.out).toContain('Recorded: 1 finding(s) from the review threads.');
    expect(recorded.out).toContain('note: Dates: thread t_gone is not in the period, left out');
    const auditFindings = await slk(
      ['retro', 'findings', id, '--source', 'audit', '--body', '-', '--format', 'json'],
      JSON.stringify({
        findings: [
          {
            subject: 'Stale skill',
            cause: 'stale',
            audit: { location: '.claude/skills/dates/SKILL.md:2', finding: 'stale' },
            file: '.claude/skills/dates/SKILL.md',
            change: 'New text',
            confidence: 0.8,
          },
        ],
      }),
    );
    expect(JSON.parse(auditFindings.out)).toMatchObject({ recorded: true, findings: [{ id: 'A1' }] });

    const analysis = await slk(['retro', 'input', id, '--for', 'analysis']);
    expect(analysis.out).toContain('the findings of the review threads and the audit of the setup');
    const text = await readFile(analysis.out.match(/Written: (.+)/)![1]!, 'utf8');
    expect(text).toContain('### T1 · Dates');
    expect(text).toContain('- usage: skill dates NEVER USED');
    expect(text).toContain(join(work, '.silykat', 'retros', id, 'threads-input.md'));
    expect(text).not.toContain('THREAD '); // the threads stay in their file

    // An audit finding on a tool nobody used: whether to keep it is the question.
    const proposed = await slk(
      ['retro', 'propose', id, '--body', '-'],
      JSON.stringify({
        proposals: [
          utcProposal(t),
          {
            column: 'improve',
            subject: 'Stale skill',
            title: 'Fix the dates skill',
            kind: 'skill',
            file: '.claude/skills/dates/SKILL.md',
            rule: 'Old text',
            change: 'New text',
            why: 'It is stale',
            causes: ['stale'],
            evidence: [],
            target: 'project-shared',
            confidence: 0.8,
            audit: { location: '.claude/skills/dates/SKILL.md:2', finding: 'stale' },
          },
        ],
      }),
    );
    expect(proposed.code).toBe(0);
    expect(proposed.out).toContain('p2 [remove] Stale skill: 0 threads, skill never used: keep it or remove it?');
    const shown = (await slk(['retro', 'show', id, 'p2'])).out;
    expect(shown).toContain(
      '**Never used**: the audit flagged the skill dates, but nobody used it in the 5 sessions of this project that the agent still keeps on this machine (since 2026-09-01).',
    );
    expect(shown).toContain('the agent deletes the sessions inactive for more than 30 days');
    expect(shown).toContain('**The question**: keep this skill (and fix it), or remove it?');
    expect(shown).toContain('**The fix, if you keep it**:\n> New text');
    expect(shown).toContain(`> Remove the skill dates: ${join(work, '.claude', 'skills', 'dates')}`);
    const all = (await slk(['retro', 'show', id])).out;
    expect(all).toContain('- **Never used**: the audit flagged the skill dates');
    expect(all).toContain('- **Fix, if kept**: New text');
  });

  it("gives the agent's sessions to their own reading, in the mode of the retro", async () => {
    await project();
    await slk(['config', 'set', 'retro-sessions', 'insights']);
    const id = (await slk(['retro', 'start', '--all'])).out.match(/rt_\w+/)![0];
    await recordRetroSessions(new RetroBook(work), id, 'Claude Code /insights', [
      {
        id: 'sess-i',
        start: '2026-09-20T10:00:00.000Z',
        folder: work,
        facts: {},
        summary: { brief_summary: 'Claude fixed the dates in UTC.' },
      },
    ]);
    const input = await slk(['retro', 'input', id, '--for', 'sessions']);
    expect(input.out).toContain('1 session of the agent, ');
    expect(input.out).not.toContain('threads');
    const rejected = await slk(
      ['retro', 'findings', id, '--source', 'sessions', '--format', 'json', '--body', '-'],
      JSON.stringify({ findings: [{ subject: 'UTC', cause: 'no rule', confidence: 0.5 }] }),
    );
    expect(rejected.code).toBe(1);
    expect(JSON.parse(rejected.out)).toMatchObject({ recorded: false, findings: [] });
    const recorded = await slk(
      ['retro', 'findings', id, '--source', 'sessions', '--body', '-'],
      JSON.stringify({
        findings: [
          {
            subject: 'UTC',
            cause: 'no rule',
            sessions: [{ session: 'sess-i', excerpt: 'fixed the dates' }],
            confidence: 0.5,
          },
        ],
        overview: { summary: 'Dates.', items: [{ kind: 'ritual', title: 'UTC check', sessions: ['sess-i'] }] },
      }),
    );
    expect(recorded.out).toBe("Recorded: 1 finding(s) from the agent's sessions, an overview of 1 item(s).\n");
  });

  it('takes the check of the last changes from the reading of the threads', async () => {
    const t = await project();
    const first = (await slk(['retro', 'start', '--all'])).out.match(/rt_\w+/)![0];
    await slk(['retro', 'propose', first, '--body', '-'], JSON.stringify({ proposals: [utcProposal(t)] }));
    await slk(['retro', 'decide', first, 'p1', 'accepted', '--target', 'project-shared']);
    await slk(['retro', 'finish', first]);
    const id = (await slk(['retro', 'start', '--all'])).out.match(/rt_\w+/)![0];
    const findings = await slk(
      ['retro', 'findings', id, '--source', 'threads', '--body', '-'],
      JSON.stringify({ findings: [], verify: [{ change: `${first}/p1`, threads: [t.utc1, t.utc2], note: 'again' }] }),
    );
    expect(findings.out).toContain(
      'Recorded: 0 finding(s) from the review threads, 1 change(s) of the last retro checked.',
    );
    expect(findings.out).toContain(
      `- ${first}/p1 Say that dates are UTC: 2 of 3 threads (67%) before, 2 of 3 threads (67%) since`,
    );
    // Left out by the analysis: the check of the threads' reading counts, and asks for a revision.
    const missing = await slk(['retro', 'check', id, '--body', '-'], JSON.stringify({ proposals: [] }));
    expect(missing.out).toContain(`add a proposal to revise it, with "revisits": "${first}/p1"`);
    const revised = await slk(
      ['retro', 'propose', id, '--body', '-'],
      JSON.stringify({
        proposals: [utcProposal(t, { title: 'Make UTC a hook', kind: 'hook', revisits: `${first}/p1` })],
      }),
    );
    expect(revised.code).toBe(0);
    expect((await new RetroBook(work).get(id)).verifications[0]).toMatchObject({
      verdict: 'not-decreased',
      note: 'again',
    });
  });

  it('keeps the check of the last changes and the overview of the sessions when the analysis leaves them out', async () => {
    const t = await project();
    const id = (await slk(['retro', 'start', '--all'])).out.match(/rt_\w+/)![0];
    const book = new RetroBook(work);
    await book.record(id, [
      {
        type: 'retro.findings',
        source: 'sessions',
        findings: [],
        overview: { summary: 'Dates come back.', items: [] },
      },
      {
        type: 'retro.findings',
        source: 'threads',
        findings: [],
        verifications: [],
      },
    ]);
    const r = await slk(['retro', 'propose', id, '--body', '-'], JSON.stringify({ proposals: [utcProposal(t)] }));
    expect(r.code).toBe(0);
    expect(r.out).toContain('overview of the sessions: 0 item(s)');
    expect((await book.get(id)).overview).toEqual({ summary: 'Dates come back.', items: [] });
  });
});

describe('slk retro', () => {
  it('announces the scope of a first retro, with periods to choose from', async () => {
    await project();
    const { code, out } = await slk(['retro', 'scope']);
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
    const json = JSON.parse((await slk(['retro', 'scope', '--format', 'json', '--all'])).out);
    expect(json).toMatchObject({ source: 'all', threads: 3, stores: [{ origin: 'below', threads: 3 }] });
    expect((await slk(['retro', 'scope', '--since', '2020-01-01'])).out).toContain('since 2020-01-01 00:00');
    expect((await slk(['retro', 'scope', '--since', '7d', '--all'])).code).toBe(1);
    expect(out).not.toContain('**History**');
    expect(json.keepHistory).toBe(true);
  });

  it('says in its scope when deleted threads are not kept', async () => {
    await project();
    await writeConfig({ keepHistory: false }, env());
    expect((await slk(['retro', 'scope'])).out).toContain(
      '- **History**: not kept on this machine (keep-history is off): deleted threads are erased, so this retro does not see them.',
    );
    expect(JSON.parse((await slk(['retro', 'scope', '--format', 'json'])).out).keepHistory).toBe(false);
  });

  it('runs a whole retro: start, classify, propose, decide, apply, finish', async () => {
    const t = await project();
    const id = await startRetro();
    expect((await slk(['retro', 'feedback', id, '--body', '-'], 'It helped')).out).toContain('Feedback recorded');

    const input = await slk(['retro', 'input', id, '--for', 'analysis']);
    expect(input.out).toContain('3 threads');
    const file = input.out.split('\n')[0]!.replace('Written: ', '');
    expect(file).toBe(join(work, '.silykat', 'retros', id, 'analysis-input.md'));
    expect(await readFile(file, 'utf8')).toContain('UTC again please');
    expect(input.out).toContain(
      `Then write your JSON in ${join(work, '.silykat', 'retros', id, 'proposals.json')} and run: slk retro check ${id} --root ${work}`,
    );
    expect((await slk(['retro', 'input', id, '--for', 'classify', '--format', 'json'])).out).toContain(
      'classify-input.md',
    );
    expect((await slk(['retro', 'input', id, '--for', 'nothing'])).code).toBe(1);

    const labels = {
      labels: [
        { thread: t.utc1, category: 3, confidence: 0.9, missingRule: 0.8, ignoredRule: 0.1 },
        { thread: t.utc2, category: 3 },
        { thread: 't_nope', category: 3 },
        { thread: t.praise, category: 99 },
      ],
    };
    const classified = await slk(
      ['retro', 'classification', id, '--by', 'haiku', '--body', '-'],
      JSON.stringify(labels),
    );
    expect(classified.out).toContain('Recorded 2 labels (2/3 threads classified).');
    expect(classified.out).toContain('Skipped t_nope: not a thread of this retro');
    expect(classified.out).toContain('category must be 1 to 14');
    expect((await slk(['retro', 'classification', id, '--body', '{}'])).code).toBe(1);
    expect((await slk(['retro', 'classification', id, '--by', 'x', '--body', '{"labels":[]}'])).err).toContain(
      'no valid label',
    );
    expect((await slk(['retro', 'classification', id, '--by', 'x', '--body', 'not json'])).err).toContain(
      'invalid JSON',
    );

    const bad = { proposals: [utcProposal(t, { causes: ['a', 'b'] })] };
    const rejected = await slk(['retro', 'propose', id, '--body', '-'], JSON.stringify(bad));
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
    const checked = await slk(['retro', 'check', id, '--body-file', join(base, 'proposals.json')]);
    expect(checked.code).toBe(0);
    expect(checked.out).toContain('The guard rails pass: 1 proposals, 1 to watch');
    expect(checked.out).toContain('p1 [improve] Dates are UTC: 2 threads, target to ask');
    expect(
      JSON.parse((await slk(['retro', 'check', id, '--format', 'json', '--body', JSON.stringify(good)])).out).recorded,
    ).toBe(false);
    expect((await slk(['retro', 'propose', id, '--body-file', join(base, 'proposals.json')])).out).toContain(
      'Recorded: 1 proposals',
    );

    const shown = (await slk(['retro', 'show', id])).out;
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
    expect(JSON.parse((await slk(['retro', 'show', id, '--format', 'json'])).out).stats).toMatchObject({
      threads: 3,
      reopened: 1,
    });

    expect((await slk(['retro', 'decide', id, 'p9', 'accepted'])).err).toContain('Proposal not found');
    expect((await slk(['retro', 'decide', id, 'p1', 'maybe'])).code).toBe(1);
    expect((await slk(['retro', 'decide', id, 'p1', 'retarget'])).err).toContain('retargeted needs --target');
    expect((await slk(['retro', 'decide', id, 'p1', 'accept', '--target', 'team'])).code).toBe(1);
    expect((await slk(['retro', 'applied', id, 'p1', '--file', 'x'])).err).toContain('was not accepted');
    expect(
      (await slk(['retro', 'decide', id, 'p1', 'retarget', '--target', 'project-personal', '--note', 'mine'])).out,
    ).toBe('p1 retargeted (project-personal).\n');
    expect((await slk(['retro', 'applied', id, 'p1'])).code).toBe(1);
    expect((await slk(['retro', 'applied', id, 'p2', '--file', 'x'])).code).toBe(2);
    expect((await slk(['retro', 'applied', id, 'p1', '--file', 'api/CLAUDE.local.md'])).out).toContain('1 file(s)');

    const finished = await slk(['retro', 'finish', id]);
    expect(finished.out).toContain('0 accepted, 0 modified, 1 with another target, 0 excluded');
    expect(finished.out).toContain(`Files changed (1):\n- ${join(work, 'api', 'CLAUDE.local.md')}`);
    expect(finished.out).toContain('To watch:\n- Small components');
    expect((await slk(['retro', 'finish', id])).err).toContain('is finished');
    expect((await slk(['retro', 'list'])).out).toContain(`${id} · ${work}`);
    expect(JSON.parse((await slk(['retro', 'list', '--format', 'json'])).out)[0]).toMatchObject({ id, proposals: 1 });

    // The next retro starts from this one, and says what it decided.
    const next = (await slk(['retro', 'scope'])).out;
    expect(next).toContain('since the last retro');
    expect(next).toContain(
      `- p1 [To improve] Say that dates are UTC: retargeted (project-personal) → ${join(work, 'api', 'CLAUDE.local.md')}`,
    );
    expect((await slk(['retro', 'start'])).err).toContain('no thread in this period');
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
    expect((await slk(['retro', 'propose', id, '--body', '-'], JSON.stringify(proposals))).code).toBe(0);

    const first = (await slk(['retro', 'show', id, '--next'])).out;
    expect(first.startsWith('---\n\n## Proposal 1/3 (p2) · To improve · Say that dates are UTC\n')).toBe(true);
    expect(first).toContain(`**Source**: 2 threads\n- ${t.utc1} (src/a.ts:1, open): "Dates are UTC here"`);
    expect(first).toContain('**Numbers**: 2 threads, 1 reopened');
    expect(first).toContain('**File**: `api/CLAUDE.md` (rule)');
    expect(first).toContain('**Proposed change**:\n> - Every date is UTC.\n> - APIs return ISO 8601 strings.');
    expect(first).toContain('**Target**: to choose (nothing in the threads tells it). Suggested: project, shared');
    expect(first).toContain('**Confidence**: 80% · recommended: accepted');
    expect(first).not.toContain('**Existing rule**');

    await slk(['retro', 'decide', id, 'p2', 'accepted']);
    const second = (await slk(['retro', 'show', id, '--next'])).out;
    expect(second).toContain('## Proposal 2/3 (p3) · To remove · Remove the tabs rule');
    expect(second).toContain(
      '**Source**: the audit of your setup (/doctor prompt-audit)\n- /doctor prompt-audit, `api/CLAUDE.md:2-3`: Contradicts "always 2 spaces"',
    );
    expect(second).not.toContain('**Numbers**');
    expect(second).toContain('**Existing rule**:\n> - Always use tabs.');
    expect((await slk(['retro', 'show', id])).out).toContain(
      '- **Source**: the audit of the setup\n  - /doctor prompt-audit, api/CLAUDE.md:2-3',
    );

    const kept = (await slk(['retro', 'show', id, 'p1'])).out;
    expect(kept).toContain('## Proposal 3/3 (p1) · To keep · Keep the small-modules rule');
    expect(kept).not.toContain('**Proposed change**');
    expect(JSON.parse((await slk(['retro', 'show', id, 'p2', '--format', 'json'])).out)).toMatchObject({
      position: 1,
      total: 3,
      decision: { decision: 'accepted' },
    });
    expect((await slk(['retro', 'show', id, 'p2'])).out).toContain('**Decision**: accepted');
    expect((await slk(['retro', 'show', id, 'p9'])).err).toContain('Proposal not found: p9');

    // A decision recorded on the wrong proposal is undone, with its files, never edited by hand.
    await slk(['retro', 'decide', id, 'p1', 'accepted']);
    await slk(['retro', 'applied', id, 'p1', '--file', 'api/CLAUDE.md']);
    expect((await slk(['retro', 'undo', id, 'p1'])).out).toBe(
      `p1: decision "accepted" undone, and its files changed forgotten (${join(work, 'api', 'CLAUDE.md')}): undo those changes if they were not for it.\n`,
    );
    expect((await slk(['retro', 'undo', id, 'p1'])).err).toContain('p1 has no decision to undo');
    expect((await slk(['retro', 'undo', id, 'p9'])).err).toContain('Proposal not found: p9');
    expect((await slk(['retro', 'undo', id, 'p2'])).out).toBe('p2: decision "accepted" undone.\n');
    expect((await slk(['retro', 'show', id, '--next'])).out).toContain('## Proposal 1/3 (p2)');
    await slk(['retro', 'decide', id, 'p2', 'accepted']);
    await slk(['retro', 'decide', id, 'p3', 'excluded', '--note', 'not now']);
    await slk(['retro', 'decide', id, 'p1', 'accepted']);
    expect((await slk(['retro', 'show', id, '--next'])).out).toBe('All 3 proposals are decided.\n');
    expect(JSON.parse((await slk(['retro', 'show', id, '--format', 'json'])).out).applied).toEqual({});
    await slk(['retro', 'finish', id]);
    expect((await slk(['retro', 'undo', id, 'p1'])).err).toContain('is finished');
  });

  it('says when no proposal is recorded yet', async () => {
    await project();
    const id = await startRetro();
    expect((await slk(['retro', 'show', id, '--next'])).out).toBe('No proposal recorded yet.\n');
  });

  it('does not propose again a subject the user excluded, unless new threads raise it', async () => {
    const t = await project();
    const first = await startRetro();
    await slk(['retro', 'propose', first, '--body', JSON.stringify({ proposals: [utcProposal(t)] })]);
    await slk(['retro', 'decide', first, 'p1', 'exclude', '--note', 'not a rule']);
    expect((await slk(['retro', 'finish', first])).out).toContain('1 excluded');
    await new Promise((r) => setTimeout(r, 5));

    const second = await startRetro().catch(() => null);
    expect(second).toBeNull(); // nothing new since
    const api = new Store(join(work, 'api'));
    await api.addComment(t.utc1, { author: 'user', body: 'And here', reviewId: null });
    const id = (JSON.parse((await slk(['retro', 'start', '--all', '--format', 'json'])).out) as { id: string }).id;
    const again = await slk(['retro', 'propose', id, '--body', JSON.stringify({ proposals: [utcProposal(t)] })]);
    expect(again.out).toContain('left out: Dates are UTC (you excluded "Dates are UTC"');
    expect((await slk(['retro', 'show', id])).out).toContain('## Left out by the guard rails');
    const analysis = await readFile(join(work, '.silykat', 'retros', id, 'analysis-input.md'), 'utf8').catch(() => '');
    expect(analysis).toBe('');
    expect((await slk(['retro', 'input', id, '--for', 'analysis'])).code).toBe(0);
    expect(await readFile(join(work, '.silykat', 'retros', id, 'analysis-input.md'), 'utf8')).toContain(
      `${first}/p1: Dates are UTC (excluded`,
    );

    // Two new threads raise it again: it comes back, and says so.
    const n1 = await api.createThread(anchor(7), { author: 'user', body: 'UTC, still', reviewId: null });
    const n2 = await api.createThread(anchor(9), { author: 'user', body: 'UTC once more', reviewId: null });
    const third = (JSON.parse((await slk(['retro', 'start', '--all', '--format', 'json'])).out) as { id: string }).id;
    const back = utcProposal(t, {
      evidence: [
        { thread: n1.id, excerpt: 'UTC, still' },
        { thread: n2.id, excerpt: 'UTC once more' },
      ],
      reopens: `${first}/p1`,
    });
    expect((await slk(['retro', 'propose', third, '--body', JSON.stringify({ proposals: [back] })])).code).toBe(0);
    expect((await slk(['retro', 'show', third, '--next'])).out).toContain(
      `**Excluded before** (${day((await new RetroBook(work).get(first)).decisions.p1!.at)}), back for new threads: ${n1.id}, ${n2.id}.`,
    );
  });

  it('keeps the retro preferences of the project', async () => {
    expect((await slk(['retro', 'prefs'])).out).toBe('No retro preference yet.\n');
    expect((await slk(['retro', 'prefs', 'add', '--body', '-'], 'At most 5 proposals\n')).out).toBe(
      'Preference P1 saved: At most 5 proposals\n',
    );
    await slk(['retro', 'prefs', 'add', '--body', 'Ignore formatting']);
    expect((await slk(['retro', 'prefs'])).out).toBe('P1: At most 5 proposals\nP2: Ignore formatting\n');
    expect((await slk(['retro', 'prefs', 'remove', 'P1'])).out).toBe('Preference P1 removed.\n');
    expect((await slk(['retro', 'prefs', 'remove'])).code).toBe(1);
    expect((await slk(['retro', 'prefs', 'remove', 'P7'])).code).toBe(2);
    expect((await slk(['retro', 'prefs', 'rename'])).code).toBe(1);
    expect(JSON.parse((await slk(['retro', 'prefs', '--format', 'json'])).out)).toMatchObject([{ id: 'P2' }]);
    expect((await slk(['retro', 'scope'])).out).toContain('- P2: Ignore formatting');
    expect(await new RetroBook(work).preferences()).toHaveLength(1);
  });

  it('checks the Jev key without reading it', async () => {
    const none = (await slk(['retro', 'key'])).out;
    expect(none).toContain('Jev: no key (expected in');
    expect(none).toContain('in their own terminal');
    expect(none).toContain("sh -c 'umask 077");
    const file = join(base, 'home', '.config', 'silykat', 'jev-key');
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, 'top-secret-key\n');
    await chmod(file, 0o644);
    const open = await slk(['retro', 'key']);
    expect(open.out).toContain('mode 644: others can read it');
    expect(open.out).toContain(`chmod 600 "${file}"`);
    expect(open.out).not.toContain('top-secret-key');
    await chmod(file, 0o600);
    expect((await slk(['retro', 'key'])).out).toContain('only you can read it, in no repository). Ready.');
    const json = JSON.parse((await slk(['retro', 'key', '--format', 'json'])).out);
    expect(json).toMatchObject({ ok: true, source: 'file' });
    expect(JSON.stringify(json)).not.toContain('top-secret-key');
  });

  it('explains its mistakes', async () => {
    expect((await slk(['retro'])).err).toContain('unknown retro action: (none)');
    expect((await slk(['retro', 'show'])).err).toContain('missing <retro-id>');
    expect((await slk(['retro', 'show', 'rt_00000000000000000000000000'])).code).toBe(2);
    expect((await slk(['retro', 'feedback', 'rt_00000000000000000000000000'])).code).toBe(2);
    expect((await slk(['retro', 'start'])).err).toContain('no thread in this period');
    expect((await slk(['help'])).out).toContain('slk retro scope');
  });

  it('shows unfinished retros, decisions, guard-rail notes and missing threads', async () => {
    const t = await project();
    await slk(['retro', 'prefs', 'add', '--body', 'Short please']);
    expect((await slk(['retro', 'list'])).out).toBe('No retro yet in this project.\n');
    const started = await slk(['retro', 'start', '--all']);
    expect(started.out).toMatch(/^Retro rt_\w+ started: 3 threads, .* the start to /);
    const id = started.out.split(' ')[1]!;
    expect((await slk(['retro', 'scope', '--all'])).out).toContain(`## Unfinished retros\n\n- ${id}, started`);
    expect((await slk(['retro', 'scope', '--all'])).out).toContain('the whole history, until now');

    // Labels keyed by thread are accepted too.
    expect(
      (
        await slk([
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
    const rejected = await slk([
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
    expect((await slk(['retro', 'check', id, '--body', '{'])).err).toContain('invalid JSON');
    expect((await slk(['retro', 'check', id])).err).toContain('needs --body');
    const recorded = await slk(['retro', 'propose', id, '--body', JSON.stringify({ proposals: [keep] })]);
    expect(recorded.out).toContain('turned from keep into improve');
    expect(recorded.out).toContain('note: Keep the UTC rule: thread t_elsewhere is not in the period');
    await slk(['retro', 'decide', id, 'p1', 'modified', '--note', 'shorter']);
    const shown = (await slk(['retro', 'show', id])).out;
    expect(shown).toContain('Preferences: P1 Short please');
    expect(shown).toContain(`- ${t.utc1} (src/a.ts:1, open)\n`);
    expect(shown).toContain('**Rule**: Dates are UTC.');
    expect(shown).toContain('**Guard rail**: proposed as "keep", but you had to enforce the rule in');
    expect(shown).toContain('**Decision**: modified: shorter');
    expect(shown).toContain('**Target**: project, shared (committed, for the team)');
    const one = (await slk(['retro', 'show', id, 'p1'])).out;
    expect(one).toContain('**Existing rule**:\n> Dates are UTC.');
    expect(one).toContain('**Guard rail**: proposed as "keep", but you had to enforce the rule in');
    expect(one).toContain('**Decision**: modified: shorter');

    // A thread whose journal is gone is reported, not invented.
    await rm(join(work, 'api', '.silykat', 'threads', `${t.praise}.jsonl`));
    expect((await slk(['retro', 'input', id, '--for', 'classify'])).out).toContain(
      `1 thread(s) of the retro are no longer found: ${t.praise}`,
    );
    const finished = await slk(['retro', 'finish', id, '--format', 'json']);
    expect(JSON.parse(finished.out)).toMatchObject({ files: [], undecided: [] });
    const empty = await startRetroOn(['--all']);
    // The change adopted at the first retro must be checked: here, no thread raises its subject again.
    const unchecked = await slk(['retro', 'propose', empty, '--body', JSON.stringify({ proposals: [utcProposal(t)] })]);
    expect(unchecked.code).toBe(1);
    expect(unchecked.out).toContain(`REJECTED check of ${id}/p1: "verify" must check`);
    const verify = [{ change: `${id}/p1`, threads: [] }];
    await slk(['retro', 'propose', empty, '--body', JSON.stringify({ proposals: [utcProposal(t)], verify })]);
    expect((await slk(['retro', 'finish', empty])).out).toContain('1 without a decision (p1)');
    expect((await slk(['retro', 'scope', '--since', '2020-01-01'])).out).toContain(
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
    const file = join(base, 'home', '.config', 'silykat', 'jev-key');
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, 'k');
    await chmod(file, 0o600);
    execFileSync('git', ['init', '-q'], { cwd: join(base, 'home') });
    const inRepo = (await slk(['retro', 'key'])).out;
    expect(inRepo).toContain(`(inside the repository ${join(base, 'home')})`);
    expect(inRepo).toContain('move it out of the repository');
  });

  it('shows dates in local time', () => {
    expect(day(null)).toBe('the start');
    const d = new Date(2026, 9, 3, 7, 5);
    expect(day(d.toISOString())).toBe('2026-10-03 07:05');
  });
});

import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  adoptedChanges,
  agentSessionsFile,
  buildAnchorContext,
  cadenceSummary,
  checkFindings,
  checkProposals,
  dueReasons,
  projectAgentSessions,
  projectConfigFile,
  readAgentSessions,
  readProjectConfig,
  readSourceSettings,
  recordAgentSessions,
  RetroBook,
  retroCadence,
  sessionsRead,
  sourceInput,
  Store,
  measureText,
  writeConfig,
  writeProjectConfig,
  type AdoptedChange,
  type Anchor,
  type GuardContext,
  type GuardSession,
  type Proposal,
  type ThreadHistory,
} from '../src/index';

let base: string;
const env = () => ({ SILYKAT_HOME: join(base, 'machine'), HOME: join(base, 'home') });
const DAY = 86_400_000;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'slk-retro-sources-')));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const anchor = (): Anchor => ({
  path: 'src/a.ts',
  source: 'worktree',
  ref: null,
  sha: null,
  ...buildAnchorContext('line 1\nline 2\n', { startLine: 1, endLine: 1 }),
});

describe('the settings of the sources of a retro', () => {
  it('come from the project, else the machine, else the default', async () => {
    const work = join(base, 'work');
    expect(await readSourceSettings(work, env())).toEqual({
      sources: {
        reviews: { setting: 'ask', origin: 'default' },
        sessions: { setting: 'ask', origin: 'default' },
        audit: { setting: 'ask', origin: 'default' },
      },
      projectSet: false,
    });
    await writeConfig({ retroSourceAudit: 'no' }, env());
    await writeProjectConfig(work, { retroSourceReviews: 'yes' });
    expect(await readSourceSettings(work, env())).toEqual({
      sources: {
        reviews: { setting: 'yes', origin: 'project' },
        sessions: { setting: 'ask', origin: 'default' },
        audit: { setting: 'no', origin: 'machine' },
      },
      projectSet: true,
    });
    // The project's own file, in its store; other keys kept, values of the wrong kind ignored.
    expect(projectConfigFile(work)).toBe(join(work, '.silykat', 'config.json'));
    await writeFile(projectConfigFile(work), JSON.stringify({ retroSourceReviews: 'always', other: 1 }));
    expect(await readProjectConfig(work)).toEqual({});
    await writeProjectConfig(work, { retroSourceSessions: 'no' });
    expect(JSON.parse(await readFile(projectConfigFile(work), 'utf8'))).toEqual({
      retroSourceReviews: 'always',
      other: 1,
      retroSourceSessions: 'no',
    });
    expect(await readProjectConfig(work)).toEqual({ retroSourceSessions: 'no' });
  });

  it('are kept with the retro, which reads all of them when it started before they could be chosen', async () => {
    const book = new RetroBook(join(base, 'work'));
    const scope = { root: book.home, since: null, until: new Date().toISOString(), stores: [], threads: [], bytes: 0 };
    expect((await book.start({ ...scope, sources: ['audit', 'sessions'] })).sources).toEqual(['sessions', 'audit']);
    expect((await book.start(scope)).sources).toEqual(['reviews', 'sessions', 'audit']);
  });
});

describe('the log of agent sessions', () => {
  it('keeps each session once, with its earliest start, and the sources already imported', async () => {
    expect(await readAgentSessions(env())).toEqual({ sessions: [], imported: new Set() });
    await recordAgentSessions(
      [
        { id: 's1', agent: 'Claude', cwd: '/w', startedAt: '2026-10-02T00:00:00.000Z' },
        { id: 's1', agent: 'Claude', cwd: '/w', startedAt: '2026-10-01T00:00:00.000Z' },
      ],
      { env: env(), imported: '/home/.claude' },
    );
    // A line that cannot be read, or of a newer version, is skipped.
    await writeFile(agentSessionsFile(env()), 'oops\n{"v":9,"type":"session","id":"s9"}\n', { flag: 'a' });
    expect(await readAgentSessions(env())).toEqual({
      sessions: [{ id: 's1', agent: 'Claude', cwd: '/w', startedAt: '2026-10-01T00:00:00.000Z' }],
      imported: new Set(['/home/.claude']),
    });
  });

  it('gives the sessions of a project: its folder and those below, after a date', async () => {
    const work = join(base, 'work');
    await mkdir(join(work, 'api'), { recursive: true });
    await recordAgentSessions(
      [
        { id: 'a', agent: 'Claude', cwd: work, startedAt: '2026-10-01T00:00:00.000Z' },
        { id: 'b', agent: 'Claude', cwd: join(work, 'api'), startedAt: '2026-10-03T00:00:00.000Z' },
        { id: 'c', agent: 'Claude', cwd: `${work}-other`, startedAt: '2026-10-03T00:00:00.000Z' },
      ],
      { env: env() },
    );
    expect((await projectAgentSessions(work, null, env())).map((x) => x.id)).toEqual(['a', 'b']);
    expect((await projectAgentSessions(work, '2026-10-01T00:00:00.000Z', env())).map((x) => x.id)).toEqual(['b']);
  });
});

describe('the cadence counts the agent sessions too', () => {
  it('reminds of a retro in a project without any review thread', async () => {
    const work = join(base, 'work');
    await mkdir(work);
    const start = new Date(Date.now() - 8 * DAY).toISOString();
    await recordAgentSessions(
      [
        { id: 'a', agent: 'Claude', cwd: work, startedAt: start },
        { id: 'b', agent: 'Claude', cwd: work, startedAt: new Date().toISOString() },
      ],
      { env: env() },
    );
    const c = await retroCadence(work, { env: env() });
    expect(c).toMatchObject({ threads: 0, sessions: 2, first: 'session', since: start, days: 8, due: true });
    expect(cadenceSummary(c!)).toMatch(
      /^8 days, 0 B of review threads \(0\) and 2 agent sessions since the first agent session \(\d{4}-\d\d-\d\d\), no retro yet$/,
    );
    expect(dueReasons(c!)).toEqual(['8 days since the first agent session (reminder at 7)']);
  });

  it('starts from the first thread or session, whichever came first, and counts after the last retro', async () => {
    const work = join(base, 'work');
    const t = await new Store(work).createThread(anchor(), { author: 'user', body: 'UTC', reviewId: null });
    await recordAgentSessions([{ id: 'late', agent: 'Claude', cwd: work, startedAt: '2099-01-01T00:00:00.000Z' }], {
      env: env(),
    });
    expect(await retroCadence(work, { env: env() })).toMatchObject({
      first: 'thread',
      since: t.createdAt,
      sessions: 1,
    });
    const book = new RetroBook(work);
    const r = await book.start({
      root: work,
      since: null,
      until: '2098-01-01T00:00:00.000Z',
      stores: [],
      threads: [],
      bytes: 0,
    });
    await book.record(r.id, [{ type: 'retro.finished' }]);
    const after = await retroCadence(work, { env: env() });
    expect(after).toMatchObject({ threads: 0, sessions: 1 });
    expect(after!.first).toBeUndefined();
  });
});

describe('the changes of the last retro, measured on every source', () => {
  const t = (id: string) =>
    ({
      id,
      createdAt: '2026-10-01T00:00:00.000Z',
      lastActivityAt: '2026-10-01T00:00:00.000Z',
      conversation: [],
    }) as unknown as ThreadHistory;
  const s = (): GuardSession => ({ start: '2026-10-01T00:00:00.000Z', summary: null });
  const base0: AdoptedChange = {
    retro: 'rt_X',
    proposal: 'p1',
    column: 'improve',
    subject: 'Tests run before done',
    title: 'Run the tests before saying done',
    kind: 'rule',
    change: '- Run the tests.',
    decision: 'accepted',
    files: [],
    before: { threads: 0, total: 10 },
    beforeSessions: { sessions: 3, total: 6 },
    evidence: [],
  };
  const ctx = (over: Partial<GuardContext> = {}): GuardContext => ({
    threads: new Map(['t1', 't2'].map((id) => [id, t(id)])),
    labels: {},
    exclusions: [],
    adopted: [base0],
    sessions: new Map(['s1', 's2', 's3', 's4'].map((id) => [id, s()])),
    ...over,
  });

  it('remembers how many sessions a change rested on, out of those the retro read', async () => {
    const book = new RetroBook(join(base, 'work'));
    const r = await book.start({
      root: book.home,
      since: null,
      until: new Date().toISOString(),
      stores: [],
      threads: ['t_a'],
      bytes: 1,
    });
    const p: Proposal = {
      id: 'p1',
      column: 'improve',
      subject: 'x',
      title: 'x',
      kind: 'rule',
      file: 'CLAUDE.md',
      rule: null,
      change: 'c',
      why: 'w',
      cause: 'c',
      evidence: [],
      sessions: [
        { session: 's1', start: '', excerpt: 'e' },
        { session: 's2', start: '', excerpt: 'e' },
      ],
      sessionsOnly: true,
      figures: { threads: 0, reopened: 0, questions: 0, rounds: 0, first: '', last: '' },
      target: 'project-shared',
      targetWhy: '',
      askTarget: false,
      confidence: 0.8,
      recommendation: 'accepted',
    };
    const done = await book.record(r.id, [
      {
        type: 'retro.reports',
        source: 'test',
        sessions: ['s1', 's2', 's3'].map((id) => ({ id, start: '', status: 'analysed' as const })),
      },
      { type: 'retro.proposed', proposals: [p], watch: [], dropped: [] },
      { type: 'retro.decided', proposal: 'p1', decision: 'accepted' },
    ]);
    expect(sessionsRead(done)).toBe(3);
    expect(adoptedChanges(done)[0]).toMatchObject({
      before: { threads: 0, total: 1 },
      beforeSessions: { sessions: 2, total: 3 },
      sessions: [{ session: 's1' }, { session: 's2' }],
    });
    // A retro that did not read the sessions has none to compare with.
    expect(sessionsRead({ ...done, sources: ['reviews'] })).toBe(0);
  });

  it('measures a change on the sessions, never as stopped for want of threads', () => {
    // It rested on sessions only: the threads say nothing of it.
    const stopped = checkProposals({ proposals: [], verify: [{ change: 'rt_X/p1', sessions: [] }] }, ctx());
    expect(stopped.rejected).toEqual([]);
    expect(stopped.verifications).toMatchObject([
      { measured: ['sessions'], afterSessions: { sessions: 0, total: 4 }, verdict: 'stopped' },
    ]);
    const worse = checkProposals(
      { proposals: [], verify: [{ change: 'rt_X/p1', sessions: ['s1', 's2', 's9'] }] },
      ctx(),
    );
    expect(worse.verifications).toMatchObject([
      { afterSessions: { sessions: 2, total: 4, ids: ['s1', 's2'] }, verdict: 'not-decreased' },
    ]);
    expect(worse.notes).toContain('check of rt_X/p1: session s9 is not in the period, left out');
    // Not reduced, on 2 sessions: to revise.
    expect(worse.rejected[0]!.reasons[0]).toContain(
      'did not reduce the feedback on its subject (3 of 6 sessions (50%) before, 2 of 4 sessions (50%) since)',
    );
    // Its sessions must be checked.
    expect(checkProposals({ proposals: [], verify: [{ change: 'rt_X/p1', threads: [] }] }, ctx()).rejected).toEqual([
      { index: 0, subject: 'check of rt_X/p1', reasons: [expect.stringContaining('"sessions": [the sessions')] },
    ]);
  });

  it('judges a change on the source where it did worst', () => {
    const both = { ...base0, before: { threads: 2, total: 10 } };
    const r = checkProposals(
      { proposals: [], verify: [{ change: 'rt_X/p1', threads: [], sessions: ['s1', 's2', 's3'] }] },
      ctx({ adopted: [both] }),
    );
    expect(r.verifications).toMatchObject([{ measured: ['threads', 'sessions'], verdict: 'not-decreased' }]);
  });

  it('gives no verdict without data on the sources the change rested on', () => {
    const none = checkProposals({ proposals: [] }, ctx({ sessions: new Map() }));
    expect(none.rejected).toEqual([]);
    expect(none.verifications).toMatchObject([{ measured: [], verdict: 'not-measured' }]);
    expect(measureText(none.verifications[0]!)).toBe('');
    // From the audit alone: nothing to count.
    const audit = { ...base0, beforeSessions: undefined };
    expect(checkProposals({ proposals: [] }, ctx({ adopted: [audit] })).verifications).toMatchObject([
      { verdict: 'not-measured' },
    ]);
  });

  it('lets the reading of each source check the changes measurable on it, and only those', async () => {
    const threadsOnly = checkFindings({ findings: [] }, 'threads', ctx());
    expect(threadsOnly.rejected).toEqual([]);
    expect(threadsOnly.verifications).toBeUndefined();
    const sessions = checkFindings(
      { findings: [], verify: [{ change: 'rt_X/p1', sessions: ['s4'] }] },
      'sessions',
      ctx(),
    );
    expect(sessions.verifications).toMatchObject([
      { measured: ['sessions'], afterSessions: { sessions: 1, total: 4, ids: ['s4'] }, verdict: 'decreased' },
    ]);
    expect(checkFindings({ findings: [] }, 'sessions', ctx()).rejected).toHaveLength(1);
    // The sessions' input lists the changes to check on them.
    const book = new RetroBook(join(base, 'w'));
    const retro = await book.start({
      root: book.home,
      since: null,
      until: new Date().toISOString(),
      stores: [],
      threads: [],
      bytes: 0,
    });
    const previous = await pastWith(join(base, 'w'));
    const input = sourceInput(
      {
        retro: { ...retro, startedAt: new Date(Date.now() + 1000).toISOString() },
        threads: new Map(),
        previous: [previous],
        preferences: [],
        sessions: [{ id: 's1', start: '2026-10-01T00:00:00.000Z', folder: '/w', facts: {}, summary: null }],
      },
      'sessions',
    );
    expect(input).toContain('## Changes adopted at the last retro: did they help?');
    expect(input).toContain('  check on: sessions; before: 1 of the 1 sessions of that retro');
    expect(input).toContain('  - session s_old: "words"');
    expect(input).toContain('"verify": [{ "change": "<ref>", "sessions": ["<id>"]');
  });
});

/** A finished retro that read one session and adopted a change resting on it. */
async function pastWith(root: string) {
  const book = new RetroBook(root);
  const r = await book.start({
    root,
    since: null,
    until: new Date(Date.now() - DAY).toISOString(),
    stores: [],
    threads: [],
    bytes: 0,
    sources: ['sessions'],
  });
  await book.record(r.id, [
    {
      type: 'retro.sessions',
      source: 'test',
      sessions: [{ id: 's_old', start: '2026-09-01T00:00:00.000Z', summary: true }],
    },
    {
      type: 'retro.proposed',
      proposals: [
        {
          id: 'p1',
          column: 'improve',
          subject: 'x',
          title: 'Run the tests',
          kind: 'rule',
          file: 'CLAUDE.md',
          rule: null,
          change: 'c',
          why: 'w',
          cause: 'c',
          evidence: [],
          sessions: [{ session: 's_old', start: '', excerpt: 'words' }],
          figures: { threads: 0, reopened: 0, questions: 0, rounds: 0, first: '', last: '' },
          target: 'project-shared',
          targetWhy: '',
          askTarget: false,
          confidence: 0.8,
          recommendation: 'accepted',
        },
      ],
      watch: [],
      dropped: [],
    },
    { type: 'retro.decided', proposal: 'p1', decision: 'accepted' },
    { type: 'retro.finished' },
  ]);
  return (await book.get(r.id))!;
}

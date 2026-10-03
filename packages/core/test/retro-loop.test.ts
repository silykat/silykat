import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  adoptedChanges,
  analysisInput,
  buildAnchorContext,
  cadenceSummary,
  changesToVerify,
  checkProposals,
  configFile,
  DEFAULT_CADENCE,
  dueReasons,
  lastRetroCovering,
  readConfig,
  RetroBook,
  retroCadence,
  retroScope,
  retroThreads,
  Store,
  thresholdsOf,
  verdictOf,
  writeConfig,
  type Anchor,
  type GuardContext,
  type Proposal,
  type RetroState,
  type ThreadHistory,
} from '../src/index';

let base: string;
const env = () => ({ LOCAL_REVIEW_HOME: join(base, 'machine'), HOME: join(base, 'home') });
const DAY = 86_400_000;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'lr-retro-loop-')));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const anchor = (): Anchor => ({
  path: 'src/a.ts',
  source: 'worktree',
  ref: null,
  sha: null,
  ...buildAnchorContext('line 1\nline 2\nline 3\n', { startLine: 1, endLine: 1 }),
});
const comment = (root: string, body: string) =>
  new Store(root).createThread(anchor(), { author: 'user', body, reviewId: null });

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  id: 'p1',
  column: 'improve',
  subject: 'Dates are UTC',
  title: 'Say dates are UTC',
  kind: 'rule',
  file: 'CLAUDE.md',
  rule: null,
  change: '- Dates are UTC.',
  why: 'Two threads ask for UTC',
  cause: 'UTC not written',
  evidence: [
    { thread: 't_a', excerpt: 'UTC please' },
    { thread: 't_b', excerpt: 'UTC again' },
  ],
  figures: { threads: 2, reopened: 0, questions: 0, rounds: 0, first: '', last: '' },
  target: 'project-shared',
  targetWhy: '',
  askTarget: false,
  confidence: 0.8,
  recommendation: 'accepted',
  ...over,
});

/** A finished retro of `root` that ended `daysAgo` days ago, with its proposals and decisions. */
async function pastRetro(
  root: string,
  daysAgo: number,
  opts: {
    proposals?: Proposal[];
    decisions?: [string, 'accepted' | 'modified' | 'excluded' | 'retargeted'][];
    threads?: number;
  } = {},
): Promise<RetroState> {
  const book = new RetroBook(root);
  const until = new Date(Date.now() - daysAgo * DAY).toISOString();
  const r = await book.start({
    root,
    since: null,
    until,
    stores: [],
    threads: Array.from({ length: opts.threads ?? 10 }, (_, i) => `t_${i}`),
    bytes: 1,
  });
  const decisions = opts.decisions ?? [];
  await book.record(r.id, [
    { type: 'retro.proposed', proposals: opts.proposals ?? [], watch: [], dropped: [] },
    ...decisions.map(([proposal, decision]) => ({ type: 'retro.decided' as const, proposal, decision })),
    ...decisions
      .filter(([, decision]) => decision !== 'excluded')
      .map(([proposal]) => ({ type: 'retro.applied' as const, proposal, files: ['/x/CLAUDE.md'] })),
    { type: 'retro.finished' },
  ]);
  return (await book.get(r.id))!;
}

describe('did the changes of the last retro help?', () => {
  it('compares the share of threads on the subject, before and after', () => {
    expect(verdictOf({ threads: 4, total: 40 }, { threads: 0, total: 10 })).toBe('stopped');
    expect(verdictOf({ threads: 4, total: 40 }, { threads: 1, total: 20 })).toBe('decreased'); // 10% → 5%
    expect(verdictOf({ threads: 4, total: 40 }, { threads: 2, total: 20 })).toBe('not-decreased'); // 10% → 10%
    expect(verdictOf({ threads: 2, total: 100 }, { threads: 3, total: 10 })).toBe('not-decreased');
    expect(verdictOf({ threads: 2, total: 0 }, { threads: 1, total: 0 })).toBe('not-decreased');
  });

  it('checks the changes adopted, not the ones kept or excluded', async () => {
    const r = await pastRetro(base, 3, {
      proposals: [
        proposal(),
        proposal({ id: 'p2', column: 'keep', subject: 'Tests first' }),
        proposal({ id: 'p3', subject: 'Short commits' }),
        proposal({ id: 'p4', column: 'remove', subject: 'Old rule' }),
        proposal({ id: 'p5', subject: 'Undecided' }),
      ],
      decisions: [
        ['p1', 'modified'],
        ['p2', 'accepted'],
        ['p3', 'excluded'],
        ['p4', 'retargeted'],
      ],
    });
    const adopted = adoptedChanges(r);
    expect(adopted.map((c) => [c.proposal, c.decision])).toEqual([
      ['p1', 'modified'],
      ['p4', 'retargeted'],
    ]);
    expect(adopted[0]).toMatchObject({ before: { threads: 2, total: 10 }, files: ['/x/CLAUDE.md'], retro: r.id });
  });

  describe('in the guard rails', () => {
    const t = (id: string) =>
      ({
        id,
        createdAt: '2026-10-01T00:00:00.000Z',
        lastActivityAt: '2026-10-01T00:00:00.000Z',
        conversation: [],
      }) as unknown as ThreadHistory;
    const threads = new Map(['t_n1', 't_n2', 't_n3', 't_n4'].map((id) => [id, t(id)]));
    const change = {
      retro: 'rt_X',
      proposal: 'p1',
      column: 'improve' as const,
      subject: 'Dates are UTC',
      title: 'Say dates are UTC',
      kind: 'rule' as const,
      change: '- Dates are UTC.',
      decision: 'accepted' as const,
      files: [],
      before: { threads: 2, total: 10 },
      evidence: [],
    };
    const ctx: GuardContext = { threads, labels: {}, exclusions: [], adopted: [change] };
    const revise = {
      column: 'improve',
      subject: 'UTC rule ignored',
      title: 'Make the UTC rule a hook',
      kind: 'hook',
      file: '.claude/settings.json',
      change: 'a hook',
      why: 'The rule is ignored',
      causes: ['advisory rule'],
      evidence: ['t_n1', 't_n2'],
      target: 'project-shared',
      targetEvidence: ['t_n1'],
      confidence: 0.7,
    };

    it('wants every adopted change checked', () => {
      const r = checkProposals({ proposals: [] }, ctx);
      expect(r.rejected).toEqual([
        { index: 0, subject: 'check of rt_X/p1', reasons: [expect.stringContaining('"verify" must check')] },
      ]);
    });

    it('keeps a change whose feedback stopped or decreased', () => {
      const stopped = checkProposals({ proposals: [], verify: [{ change: 'rt_X/p1', threads: [] }] }, ctx);
      expect(stopped.rejected).toEqual([]);
      expect(stopped.verifications).toMatchObject([
        { proposal: 'p1', after: { threads: 0, total: 4, ids: [] }, verdict: 'stopped' },
      ]);
      const lower = {
        ...ctx,
        threads: new Map([...threads, ...['a', 'b', 'c', 'd', 'e', 'f'].map((x) => [x, t(x)] as const)]),
      };
      const decreased = checkProposals(
        {
          proposals: [],
          verify: [
            { change: 'rt_X/p1', threads: ['t_n1', 't_gone'], note: 'once' },
            { change: 'rt_Y/p9', threads: [] },
          ],
        },
        lower,
      );
      expect(decreased.verifications).toMatchObject([
        { after: { threads: 1, total: 10, ids: ['t_n1'] }, verdict: 'decreased', note: 'once' },
      ]);
      expect(decreased.rejected).toEqual([]);
      expect(decreased.notes).toEqual([
        'check of rt_X/p1: thread t_gone is not in the period, left out',
        'check of rt_Y/p9: not a change adopted at the last retro, ignored',
      ]);
    });

    it('proposes to revise a change that did not reduce the feedback', () => {
      const verify = [{ change: 'rt_X/p1', threads: ['t_n1', 't_n2'] }];
      const missing = checkProposals({ proposals: [], verify }, ctx);
      expect(missing.rejected[0]!.reasons[0]).toContain(
        'did not reduce the feedback on its subject (2 of 10 threads before, 2 of 4 now)',
      );
      const wrong = checkProposals({ proposals: [{ ...revise, revisits: 'rt_X/p7' }], verify }, ctx);
      expect(wrong.rejected[0]!.reasons).toEqual([expect.stringContaining('"revisits" names "rt_X/p7"')]);
      const ok = checkProposals({ proposals: [{ ...revise, revisits: 'rt_X/p1' }], verify }, ctx);
      expect(ok.rejected).toEqual([]);
      expect(ok.proposals[0]!.revisits).toEqual({ retro: 'rt_X', proposal: 'p1', verdict: 'not-decreased' });
      // It revises a change where it was made: no need to ask the target again.
      const noTarget = checkProposals(
        { proposals: [{ ...revise, targetEvidence: [], revisits: 'rt_X/p1' }], verify },
        ctx,
      );
      expect(noTarget.proposals[0]!.askTarget).toBe(false);
    });
  });

  it('gives the analysis the changes to check, and records the check', async () => {
    const work = join(base, 'work');
    const last = await pastRetro(work, 2, { proposals: [proposal()], decisions: [['p1', 'accepted']] });
    // The retro of another project: not checked here.
    await pastRetro(join(base, 'other'), 1, { proposals: [proposal()], decisions: [['p1', 'accepted']] });
    const t1 = await comment(work, 'Still not UTC');
    const scope = await retroScope(work, { env: env() });
    expect(scope.toVerify.map((c) => `${c.retro}/${c.proposal}`)).toEqual([`${last.id}/p1`]);

    const book = new RetroBook(work);
    const r = await book.start({
      root: work,
      since: scope.since,
      until: scope.until,
      stores: [],
      threads: [t1.id],
      bytes: 1,
    });
    const previous = (await book.list()).filter((x) => x.id !== r.id);
    expect(changesToVerify(r, previous).map((c) => c.retro)).toEqual([last.id]);
    const { threads } = await retroThreads(r, env());
    const input = analysisInput({ retro: r, threads, previous, preferences: [] });
    expect(input).toContain('## Changes adopted at the last retro: did they help?');
    expect(input).toContain(
      `- ${last.id}/p1 [improve] Say dates are UTC (rule, accepted, changed: /x/CLAUDE.md): Dates are UTC`,
    );
    expect(input).toContain('  before: 2 of the 10 threads of that retro; change: - Dates are UTC.');
    expect(input).toContain('  - t_a: "UTC please"');

    const check = checkProposals(
      { proposals: [], verify: [{ change: `${last.id}/p1`, threads: [t1.id] }] },
      {
        threads: new Map([...threads].map(([id, x]) => [id, x.thread])),
        labels: {},
        exclusions: [],
        adopted: changesToVerify(r, previous),
      },
    );
    await book.record(r.id, [
      { type: 'retro.proposed', proposals: [], watch: [], dropped: [], verifications: check.verifications },
    ]);
    expect((await book.get(r.id))!.verifications).toMatchObject([
      { proposal: 'p1', before: { threads: 2, total: 10 }, after: { threads: 1, total: 1 }, verdict: 'not-decreased' },
    ]);
    // Without anything adopted, nothing to check.
    expect(analysisInput({ retro: r, threads, previous: [], preferences: [] })).not.toContain('did they help');
  });
});

describe('the cadence of retros', () => {
  const at = (days: number) => ({ env: env(), now: Date.now() + days * DAY });

  it('counts the days and the size since the first thread, before any retro', async () => {
    const work = join(base, 'work');
    await mkdir(work);
    expect(await retroCadence(work, at(0))).toMatchObject({ threads: 0, days: 0, due: false, since: null });
    const t = await comment(join(work, 'api'), 'Use UTC');
    const now = await retroCadence(work, at(0));
    expect(now).toMatchObject({ lastRetro: null, threads: 1, days: 0, due: false, reasons: [] });
    expect(now!.bytes).toBeGreaterThan(0);
    expect(now!.since).toBe(t.createdAt);
    expect(now!.thresholds).toEqual(DEFAULT_CADENCE);
    expect(cadenceSummary(now!)).toMatch(
      /^no retro yet: \d+(\.\d)? (B|KB) of review threads \(1\) since the first one, 0 days ago/,
    );
    const week = await retroCadence(work, at(7.5));
    expect(week).toMatchObject({ days: 7, due: true, reasons: ['days'] });
    expect(dueReasons(week!)).toEqual(['7 days since the first thread (reminder at 7)']);
  });

  it('starts again after the last retro of the folder, or of a folder above it', async () => {
    const work = join(base, 'work');
    const api = join(work, 'api');
    await comment(api, 'Use UTC');
    const r = await pastRetro(work, 3);
    expect((await lastRetroCovering(api))!.id).toBe(r.id);
    const c = await retroCadence(api, { env: env() });
    expect(c).toMatchObject({ lastRetro: { id: r.id, root: work }, days: 3, threads: 1, due: false });
    expect(cadenceSummary(c!)).toMatch(
      /^3 days and .* of review threads \(1\) since the last retro \(\d{4}-\d\d-\d\d\)$/,
    );
    // A retro of a sibling folder does not cover this one.
    await pastRetro(join(work, 'web'), 1);
    expect((await lastRetroCovering(api))!.id).toBe(r.id);
    // Nothing new since the last retro: nothing to look back at, however long ago.
    await pastRetro(api, 0);
    expect(await retroCadence(api, at(40))).toMatchObject({ threads: 0, due: false, days: 40 });
  });

  it('is due sooner for a big batch of threads, and never later than the maximum', async () => {
    const work = join(base, 'work');
    await comment(work, 'Use UTC');
    const small = { days: 30, bytes: 10, maxDays: 25 };
    expect(await retroCadence(work, { env: env(), thresholds: small })).toMatchObject({ due: true, reasons: ['size'] });
    const late = await retroCadence(work, { ...at(26), thresholds: { ...small, bytes: 1e9 } });
    expect(late).toMatchObject({ due: true, reasons: ['days', 'max-days'] });
    expect(dueReasons(late!)[0]).toBe('26 days since the first thread (reminder at 25)');
    expect(dueReasons(late!)[1]).toContain('25 days or more: agents delete their conversations');
    expect(dueReasons({ ...late!, reasons: ['size'] })[0]).toMatch(
      /of threads to look back at \(reminder at 1000\.0 MB\)/,
    );
  });

  it('reads its thresholds from the machine settings, and is no matter for the root of the disk', async () => {
    const work = join(base, 'work');
    await comment(work, 'Use UTC');
    await writeConfig({ retroReminderDays: 2, retroReminderSizeKB: 5000, retroReminderMaxDays: 20 }, env());
    expect((await retroCadence(work, { env: env() }))!.thresholds).toEqual({ days: 2, bytes: 5_000_000, maxDays: 20 });
    expect(await retroCadence('/', { env: env() })).toBeNull();
  });
});

describe('the reminder settings of the machine', () => {
  it('have defaults, and ignore values of the wrong kind', async () => {
    expect(await readConfig(env())).toEqual({
      autoSaveWorktrees: true,
      retroReminder: true,
      retroReminderDays: 7,
      retroReminderSizeKB: 1000,
      retroReminderMaxDays: 25,
    });
    await mkdir(join(base, 'machine'), { recursive: true });
    await writeFile(
      configFile(env()),
      JSON.stringify({
        retroReminder: false,
        retroReminderDays: 0,
        retroReminderSizeKB: 2.5,
        retroReminderMaxDays: 30,
      }),
    );
    expect(await readConfig(env())).toMatchObject({
      retroReminder: false,
      retroReminderDays: 7,
      retroReminderSizeKB: 1000,
      retroReminderMaxDays: 30,
    });
    expect(thresholdsOf(await readConfig(env()))).toEqual({ days: 7, bytes: 1_000_000, maxDays: 30 });
    await writeFile(configFile(env()), '[1]');
    expect((await readConfig(env())).retroReminderDays).toBe(7);
  });
});

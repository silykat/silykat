import { execFileSync } from 'node:child_process';
import { appendFile, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  analysisInput,
  buildAnchorContext,
  checkProposals,
  classifyInput,
  estimate,
  exclusionsOf,
  figuresOf,
  jevKeySetupCommand,
  jevKeyStatus,
  prepareStoreHome,
  projectHistory,
  RetroBook,
  retroHome,
  retroScope,
  retroStats,
  retroThreads,
  similarity,
  Store,
  threadHistory,
  threadSignals,
  threadText,
  type Anchor,
  type GuardContext,
  type RetroState,
  type ThreadEvent,
  type ThreadHistory,
} from '../src/index';

let base: string;
const env = () => ({ LOCAL_REVIEW_HOME: join(base, 'machine'), HOME: join(base, 'home') });
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd, stdio: 'pipe' });

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'lr-retro-')));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const FILE = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
const anchor = (over: Partial<Anchor> = {}): Anchor => ({
  path: 'src/a.ts',
  source: 'worktree',
  ref: null,
  sha: null,
  ...buildAnchorContext(FILE, { startLine: 3, endLine: 4 }),
  ...over,
});

const at = (minute: number) => `2026-09-26T10:${String(minute).padStart(2, '0')}:00.000Z`;
let n = 0;
/** A thread's history from a short script: `u` user comment, `a` agent comment, statuses by name. */
function thread(steps: string[], id = `t_${String(++n).padStart(26, '0')}`): ThreadHistory {
  const events: ThreadEvent[] = [
    { v: 1, type: 'thread.created', at: at(0), by: 'user', threadId: id, anchor: anchor() },
  ];
  steps.forEach((s, i) => {
    const [who, what] = s.split(':') as [string, string];
    const by = who === 'a' ? 'agent' : 'user';
    const agent = by === 'agent' ? { agent: 'Claude' } : {};
    if (what === 'c')
      events.push({
        v: 1,
        type: 'comment.added',
        at: at(i + 1),
        by,
        ...agent,
        commentId: `c${i}`,
        body: `${who}${i}`,
        reviewId: null,
      });
    else if (what === 'deleted') events.push({ v: 1, type: 'thread.deleted', at: at(i + 1), by });
    else events.push({ v: 1, type: 'status.changed', at: at(i + 1), by, ...agent, status: what as 'open' });
  });
  return threadHistory(events)!;
}

describe('signals and statistics', () => {
  it('sees reopened threads, questions and back-and-forth', () => {
    const t = thread(['u:c', 'a:c', 'a:needs-info', 'u:c', 'u:open', 'a:c', 'a:addressed', 'u:open']);
    expect(threadSignals(t)).toEqual({ reopened: true, question: true, rounds: 1 });
    const quiet = thread(['u:c', 'a:c', 'a:addressed', 'u:resolved']);
    expect(threadSignals(quiet)).toEqual({ reopened: false, question: false, rounds: 0 });
    const s = retroStats([t, quiet, thread(['u:c', 'u:deleted'])], {
      [t.id]: { category: 2, ignoredRule: 0.9 },
      [quiet.id]: { category: 3, missingRule: 0.7 },
    });
    expect(s).toMatchObject({
      threads: 3,
      reopened: 1,
      questions: 1,
      backAndForth: 1,
      deleted: 1,
      missingRule: 1,
      ignoredRule: 1,
    });
    expect(s.categories).toEqual({ 2: 1, 3: 1 });
    expect(figuresOf([t, quiet])).toMatchObject({ threads: 2, reopened: 1, questions: 1, rounds: 1, first: at(0) });
    expect(figuresOf([])).toMatchObject({ threads: 0, first: '', last: '' });
  });

  it('estimates tokens and durations from the text the agents read', () => {
    const t = thread(['u:c', 'a:c']);
    expect(threadText(t, '/repo')).toContain(`THREAD ${t.id} · src/a.ts:3-4 · open · store /repo`);
    const e = estimate({
      root: '/',
      since: null,
      stores: [
        {
          root: '/r',
          origin: 'root',
          threads: [t],
          bytes: 1,
          states: {} as never,
          deletions: {} as never,
          archived: 0,
          warnings: [],
        },
      ],
      threads: 1,
      bytes: 1,
      states: {} as never,
      deletions: {} as never,
      archived: 0,
    });
    expect(e.tokens).toBeGreaterThan(10);
    expect(e.classifyJev).toBeLessThan(e.classifyModel);
    expect(e.analysis).toBeGreaterThanOrEqual(60);
  });
});

describe('similarity of subjects', () => {
  it('compares the meaningful words, accents and case aside', () => {
    expect(similarity('Dates are UTC ISO strings', 'UTC ISO strings for dates')).toBe(1);
    expect(similarity('Les dates en UTC', 'dates UTC')).toBe(1);
    expect(similarity('Run the tests before done', 'Money in cents')).toBe(0);
    expect(similarity('', 'x')).toBe(0);
  });
});

describe('guard rails', () => {
  const a = thread(['u:c', 'a:c', 'a:addressed']);
  const b = thread(['u:c', 'a:c', 'a:addressed']);
  const c = thread(['u:c']);
  const ctx = (over: Partial<GuardContext> = {}): GuardContext => ({
    threads: new Map([a, b, c].map((t) => [t.id, t])),
    labels: {},
    exclusions: [],
    ...over,
  });
  const ev = (...ts: ThreadHistory[]) => ts.map((t) => ({ thread: t.id, excerpt: 'quote' }));
  const proposal = (over: Record<string, unknown> = {}) => ({
    column: 'improve',
    subject: 'Dates are UTC',
    title: 'Say dates are UTC',
    kind: 'rule',
    file: 'CLAUDE.md',
    change: '- Dates are UTC.',
    why: 'Two threads ask for UTC',
    causes: ['UTC not written'],
    evidence: ev(a, b),
    target: 'project-shared',
    targetEvidence: [a.id],
    confidence: 0.8,
    ...over,
  });

  it('keeps a proposal backed by 2 threads, with its numbers', () => {
    const r = checkProposals({ proposals: [proposal()] }, ctx());
    expect(r.rejected).toEqual([]);
    expect(r.proposals[0]).toMatchObject({
      id: 'p1',
      column: 'improve',
      askTarget: false,
      cause: 'UTC not written',
      recommendation: 'accepted',
    });
    expect(r.proposals[0]!.figures).toMatchObject({ threads: 2, questions: 0 });
  });

  describe("with the agent's sessions", () => {
    const summary = { friction_detail: 'The user rejected the first fix.', brief_summary: 'Claude fixed the tests.' };
    const sessions = new Map([
      ['s1', { start: '2026-09-20T10:00:00.000Z', summary }],
      ['s2', { start: '2026-09-21T10:00:00.000Z', summary: null }],
    ]);

    it('counts cited sessions as evidence, quoted from their summary, and says when there is no thread', () => {
      const r = checkProposals(
        {
          proposals: [
            proposal({
              evidence: [],
              sessions: [
                { session: 's1', excerpt: '…rejected   the first fix' },
                's2',
                { session: 's-unknown', excerpt: 'x' },
                's1',
              ],
            }),
            proposal({ subject: 'Mixed', evidence: ev(a), sessions: ['s1'] }),
          ],
        },
        ctx({ sessions }),
      );
      expect(r.rejected).toEqual([]);
      expect(r.proposals[0]).toMatchObject({
        sessionsOnly: true,
        sessions: [
          { session: 's1', start: '2026-09-20T10:00:00.000Z', excerpt: '…rejected   the first fix' },
          { session: 's2', start: '2026-09-21T10:00:00.000Z', excerpt: '' },
        ],
        figures: { threads: 0 },
      });
      expect(r.notes).toContain(
        'Dates are UTC: session s-unknown is not one the retro reads, left out of its evidence',
      );
      // A thread and a session make two pieces of evidence; without an excerpt, the summary's own words.
      expect(r.proposals[1]).toMatchObject({ subject: 'Mixed', sessions: [{ excerpt: summary.friction_detail }] });
      expect(r.proposals[1]!.sessionsOnly).toBeUndefined();
    });

    it("refuses an excerpt that is not in the session's summary, and watches a single session", () => {
      const bad = checkProposals(
        {
          proposals: [proposal({ evidence: [], sessions: [{ session: 's1', excerpt: 'The user was happy.' }, 's2'] })],
        },
        ctx({ sessions }),
      );
      expect(bad.rejected[0]!.reasons[0]).toContain('the excerpt of session s1 is not in its summary');
      const one = checkProposals({ proposals: [proposal({ evidence: [], sessions: ['s1'] })] }, ctx({ sessions }));
      expect(one.proposals).toEqual([]);
      expect(one.watch[0]).toMatchObject({ evidence: [], sessions: [{ session: 's1' }] });
      const none = checkProposals({ proposals: [proposal({ evidence: [], sessions: ['s9'] })] }, ctx({ sessions }));
      expect(none.rejected[0]!.reasons[0]).toContain('none of the threads or sessions it cites');
      // Without sessions read, a citation of one is left out.
      expect(
        checkProposals({ proposals: [proposal({ sessions: ['s1'] })] }, ctx()).proposals[0]!.sessions,
      ).toBeUndefined();
    });
  });

  it('moves a single-thread preference to the watch list, and drops what no thread supports', () => {
    const r = checkProposals(
      {
        proposals: [proposal({ evidence: ev(a) }), proposal({ subject: 'Ghost', evidence: [{ thread: 't_unknown' }] })],
        watch: [
          { subject: 'No default exports', why: 'once', evidence: ev(c) },
          { subject: '', evidence: [] },
        ],
      },
      ctx(),
    );
    expect(r.proposals).toEqual([]);
    expect(r.watch.map((w) => [w.id, w.subject])).toEqual([
      ['w1', 'No default exports'],
      ['w2', 'Dates are UTC'],
    ]);
    expect(r.dropped).toEqual([]);
    expect(r.rejected).toEqual([
      { index: 2, subject: 'Ghost', reasons: [expect.stringContaining('none of the threads or sessions it cites')] },
    ]);
    expect(r.notes.join('\n')).toContain('t_unknown is not in the period');
  });

  it('takes the column and the threads as people write them, and wants evidence', () => {
    const r = checkProposals(
      {
        proposals: [
          proposal({ column: 'To Improve', evidence: undefined, threads: [a.id, b.id] }),
          proposal({ evidence: [] }),
        ],
      },
      ctx(),
    );
    expect(r.proposals[0]).toMatchObject({
      column: 'improve',
      evidence: [
        { thread: a.id, excerpt: '' },
        { thread: b.id, excerpt: '' },
      ],
    });
    expect(r.rejected[0]!.reasons).toEqual([expect.stringContaining('"evidence" is missing')]);
  });

  it('rejects a proposal mixing several causes, or missing what it must say', () => {
    const r = checkProposals(
      {
        proposals: [
          proposal({ causes: ['a', 'b'] }),
          proposal({
            column: 'sideways',
            target: 'team',
            kind: 'magic',
            why: '',
            file: '',
            change: '',
            causes: [],
            confidence: 2,
            recommendation: 'maybe',
          }),
          proposal({ column: 'keep', rule: '' }),
          'nope',
        ],
      },
      ctx(),
    );
    expect(r.proposals).toEqual([]);
    expect(r.rejected.map((x) => x.index)).toEqual([1, 2, 3, 4]);
    expect(r.rejected[0]!.reasons[0]).toContain('one subject per proposal');
    expect(r.rejected[1]!.reasons.length).toBeGreaterThanOrEqual(7);
    expect(r.rejected[2]!.reasons).toEqual(['a "keep" names the existing rule it keeps ("rule")']);
    expect(checkProposals('x', ctx()).rejected[0]!.reasons[0]).toContain('"proposals"');
  });

  it('takes a finding of the setup audit without threads, to remove or rewrite a rule', () => {
    const audit = { location: 'CLAUDE.md:2-3', finding: 'Two rules contradict each other on tabs' };
    const stale = proposal({
      column: 'remove',
      subject: 'Tabs or spaces',
      rule: '- Always use tabs.',
      evidence: [],
      targetEvidence: [],
      audit,
    });
    const r = checkProposals(
      {
        proposals: [
          stale,
          proposal({ subject: 'With one thread', evidence: ev(a), audit }),
          proposal({ column: 'keep', subject: 'Kept', rule: '- x', audit }),
          proposal({ subject: 'Half an audit', audit: { location: 'CLAUDE.md' } }),
        ],
      },
      ctx(),
    );
    expect(r.proposals.map((p) => [p.id, p.subject, p.figures.threads, p.audit])).toEqual([
      ['p1', 'Tabs or spaces', 0, audit],
      ['p2', 'With one thread', 1, audit],
    ]);
    expect(r.proposals[0]!.figures).toMatchObject({ first: '', last: '' });
    expect(r.watch).toEqual([]);
    expect(r.rejected).toEqual([
      { index: 3, subject: 'Kept', reasons: [expect.stringContaining('"remove" or "improve"')] },
      { index: 4, subject: 'Half an audit', reasons: ['"audit" needs a "location" and a "finding"'] },
    ]);
  });

  it('turns a "keep" into "improve" when the rule had to be enforced', () => {
    const keep = proposal({ column: 'keep', rule: 'Amounts in cents.', change: '' });
    expect(checkProposals({ proposals: [keep] }, ctx()).proposals[0]!.column).toBe('keep');
    const enforced = checkProposals({ proposals: [{ ...keep, enforcedIn: [b.id, 't_elsewhere'] }] }, ctx())
      .proposals[0]!;
    expect(enforced).toMatchObject({ column: 'improve', kind: 'hook', convertedFromKeep: { threads: [b.id] } });
    expect(enforced.change).toContain('hook');
    const classified = checkProposals({ proposals: [keep] }, ctx({ labels: { [a.id]: { category: 2 } } }))
      .proposals[0]!;
    expect(classified.convertedFromKeep).toEqual({ threads: [a.id] });
    const flagged = checkProposals(
      { proposals: [keep] },
      ctx({ labels: { [b.id]: { category: 7, ignoredRule: 0.6 } } }),
    );
    expect(flagged.proposals[0]!.column).toBe('improve');
  });

  it('asks the target of a new rule when no thread tells it', () => {
    const ask = (over: Record<string, unknown>) =>
      checkProposals({ proposals: [proposal(over)] }, ctx()).proposals[0]!.askTarget;
    expect(ask({ targetEvidence: [] })).toBe(true);
    expect(ask({ targetEvidence: ['t_elsewhere'] })).toBe(true);
    expect(ask({ targetEvidence: [], rule: 'Existing rule.' })).toBe(false);
    expect(ask({ targetEvidence: [], column: 'remove', rule: 'Old rule.' })).toBe(false);
  });

  it('never proposes an excluded subject again without new feedback', () => {
    const exclusion = { retro: 'rt_X', proposal: 'p2', subject: 'Dates are UTC', at: at(30), threads: [a.id] };
    const dropped = checkProposals({ proposals: [proposal()] }, ctx({ exclusions: [exclusion] }));
    expect(dropped.proposals).toEqual([]);
    expect(dropped.dropped[0]!.reason).toContain('you excluded "Dates are UTC"');
    // Threads active after the exclusion, not cited by it: new feedback.
    const later = (t: ThreadHistory) => ({ ...t, lastActivityAt: '2026-10-01T00:00:00.000Z' });
    const back = checkProposals(
      { proposals: [proposal({ subject: 'Something else', reopens: 'rt_X/p2', evidence: ev(b, c) })] },
      ctx({ exclusions: [exclusion], threads: new Map([a, later(b), later(c)].map((t) => [t.id, t])) }),
    );
    expect(back.proposals[0]!.reopens).toEqual({ retro: 'rt_X', proposal: 'p2', at: at(30), newThreads: [b.id, c.id] });
    // Worded otherwise, but resting on the threads of the excluded subject: the same subject.
    const reworded = checkProposals(
      { proposals: [proposal({ subject: 'Timestamps in Coordinated Universal Time' })] },
      ctx({ exclusions: [{ ...exclusion, threads: [a.id, b.id] }] }),
    );
    expect(reworded.dropped[0]!.reason).toContain('fewer than 2 new threads');
    expect(
      checkProposals({ proposals: [proposal({ subject: 'Timestamps' })] }, ctx({ exclusions: [exclusion] })).proposals,
    ).toHaveLength(1);
  });

  it('does not watch an excluded subject either, without new feedback', () => {
    const exclusion = { retro: 'rt_X', proposal: 'p2', subject: 'Dates are UTC', at: at(30), threads: [a.id] };
    const later = (t: ThreadHistory) => ({ ...t, lastActivityAt: '2026-10-01T00:00:00.000Z' });
    const r = checkProposals(
      {
        proposals: [proposal({ evidence: ev(b) })],
        watch: [
          { subject: 'Dates are UTC please', why: 'once', evidence: ev(c) },
          { subject: 'No default exports', why: 'once', evidence: ev(c) },
        ],
      },
      ctx({ exclusions: [exclusion], threads: new Map([a, later(b), later(c)].map((t) => [t.id, t])) }),
    );
    expect(r.proposals).toEqual([]);
    expect(r.watch.map((w) => w.subject)).toEqual(['No default exports']);
    expect(r.dropped.map((d) => d.subject)).toEqual(['Dates are UTC', 'Dates are UTC please']);
    expect(r.dropped[0]!.reason).toContain('fewer than 2 new threads');
  });
});

const created = (id: string, minute: number): ThreadEvent => ({
  v: 1,
  type: 'thread.created',
  at: at(minute),
  by: 'user',
  threadId: id,
  anchor: anchor(),
});

describe('the retro journal', () => {
  const scope = (root: string) => ({ root, since: null, until: at(59), stores: [], threads: ['t_1'], bytes: 10 });

  it('records a retro from start to finish, and folds it back', async () => {
    const book = new RetroBook(base);
    await book.addPreference('  At most 5 proposals ');
    const r = await book.start(scope(base));
    expect(r.id).toMatch(/^rt_/);
    expect(r.preferences.map((p) => p.body)).toEqual(['At most 5 proposals']);
    await book.record(r.id, [
      { type: 'retro.feedback', body: 'It helped' },
      { type: 'retro.classified', by: 'jev', labels: { t_1: { category: 3 } } },
      { type: 'retro.classified', by: 'haiku', labels: { t_2: { category: 2 } } },
    ]);
    const p = checkProposals({ proposals: [] }, { threads: new Map(), labels: {}, exclusions: [] });
    await book.record(r.id, [{ type: 'retro.proposed', proposals: p.proposals, watch: [], dropped: [] }]);
    await book.record(r.id, [
      { type: 'retro.decided', proposal: 'p1', decision: 'accepted' },
      { type: 'retro.decided', proposal: 'p1', decision: 'retargeted', target: 'user', note: 'mine' },
      { type: 'retro.applied', proposal: 'p1', files: ['/a', '/b'] },
      { type: 'retro.applied', proposal: 'p1', files: ['/b', '/c'] },
      { type: 'retro.finished' },
    ]);
    const done = (await book.get(r.id))!;
    expect(done.feedback).toEqual(['It helped']);
    expect(done.classification).toEqual({
      by: ['jev', 'haiku'],
      labels: { t_1: { category: 3 }, t_2: { category: 2 } },
    });
    expect(done.decisions.p1).toMatchObject({ decision: 'retargeted', target: 'user', note: 'mine' });
    expect(done.applied.p1).toEqual(['/a', '/b', '/c']);
    expect(done.finishedAt).not.toBeNull();
    await expect(book.record(r.id, [{ type: 'retro.finished' }])).rejects.toThrow('is finished');
    expect((await book.lastFinished(base))!.id).toBe(r.id);
    expect(await book.lastFinished(join(base, 'other'))).toBeNull();
  });

  it('lists retros oldest first, and tolerates damaged or newer lines', async () => {
    const book = new RetroBook(base);
    expect(await book.list()).toEqual([]);
    expect(await book.read('rt_00000000000000000000000000')).toBeNull();
    await expect(book.get('rt_00000000000000000000000000')).rejects.toThrow('Retro not found');
    expect(() => book.retroFile('../x')).toThrow('Invalid retro id');
    await expect(book.workDir('nope')).rejects.toThrow('Invalid retro id');
    const one = await book.start(scope(base));
    await new Promise((r) => setTimeout(r, 5));
    const two = await book.start(scope(base));
    expect((await book.list()).map((r) => r.id)).toEqual([one.id, two.id]);
    await appendFile(
      book.retroFile(two.id),
      'not json\n[1]\n{"v":1,"type":"retro.unknown","at":"x"}\n{"v":99,"type":"retro.finished","at":"x"}\npartial',
    );
    const damaged = (await book.get(two.id))!;
    expect(damaged.warnings).toHaveLength(3);
    expect(damaged.readOnly).toBe(true);
    await expect(book.record(two.id, [{ type: 'retro.finished' }])).rejects.toThrow('newer version');
    await writeFile(
      join(book.dir, 'rt_00000000000000000000000001.jsonl'),
      '{"v":1,"type":"retro.finished","at":"x"}\n',
    );
    expect(await book.list()).toHaveLength(2);
  });

  it('keeps preferences, never reusing an id', async () => {
    const book = new RetroBook(base);
    expect(await book.preferences()).toEqual([]);
    await expect(book.addPreference('  ')).rejects.toThrow('cannot be empty');
    const p1 = await book.addPreference('Ignore formatting');
    await book.addPreference('Less detail');
    await book.removePreference(p1.id);
    await expect(book.removePreference('P9')).rejects.toThrow('Preference not found');
    const p3 = await book.addPreference('More detail');
    expect(p3.id).toBe('P3');
    expect((await book.preferences()).map((p) => p.id)).toEqual(['P2', 'P3']);
  });

  it('keeps retros next to the comments of the project', async () => {
    const repo = join(base, 'repo');
    await mkdir(join(repo, 'src'), { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    // A subfolder of a repository: the top of the repository.
    expect(await retroHome(join(repo, 'src'), env())).toBe(repo);
    // Outside git: the folder itself.
    await mkdir(join(base, 'loose'));
    expect(await retroHome(join(base, 'loose'), env())).toBe(join(base, 'loose'));
    // A folder holding a store: itself.
    await new Store(join(repo, 'src')).createThread(anchor(), { author: 'user', body: 'x', reviewId: null });
    expect(await retroHome(join(repo, 'src'), env())).toBe(join(repo, 'src'));
    await expect(retroHome('/')).rejects.toThrow('project folder');
  });

  it('tells git to ignore the retros when it creates the store', async () => {
    const repo = join(base, 'repo');
    await mkdir(repo);
    git(repo, 'init', '-q', '-b', 'main');
    await writeFile(join(repo, '.git', 'info', 'exclude'), '# mine');
    await prepareStoreHome(repo);
    await prepareStoreHome(repo);
    expect(await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8')).toBe('# mine\n.local-review/\n');
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo }).toString()).toBe('');
    await mkdir(join(base, 'plain'));
    await prepareStoreHome(join(base, 'plain'));
    expect(await realpath(join(base, 'plain', '.local-review'))).toBeTruthy();
  });
});

describe('the scope of a retro', () => {
  it('proposes a period for a first retro, then starts from the last one', async () => {
    const api = new Store(join(base, 'work', 'api'));
    const t = await api.createThread(anchor(), { author: 'user', body: 'Use UTC', reviewId: null });
    await new Promise((r) => setTimeout(r, 5));
    const now = Date.now();
    const first = await retroScope(join(base, 'work'), { env: env(), now });
    expect(first.source).toBe('proposed');
    expect(first.options.map((o) => [o.label, o.flag, o.threads, o.proposed, o.overlapsLastRetro])).toEqual([
      ['last 7 days', '--since 7d', 1, true, false],
      ['last 30 days', '--since 30d', 1, false, false],
      ['whole history', '--all', 1, false, false],
    ]);
    expect(first.history.threads).toBe(1);
    expect(first.home).toBe(join(base, 'work'));

    const book = new RetroBook(first.home);
    const r = await book.start({
      root: first.root,
      since: first.since,
      until: first.until,
      stores: [],
      threads: [t.id],
      bytes: 1,
    });
    expect((await retroScope(join(base, 'work'), { env: env() })).unfinished.map((x) => x.id)).toEqual([r.id]);
    await book.record(r.id, [{ type: 'retro.finished' }]);
    const next = await retroScope(join(base, 'work'), { env: env() });
    expect(next).toMatchObject({
      source: 'last-retro',
      since: new Date(Date.parse(first.until) + 1).toISOString(),
      unfinished: [],
    });
    expect(next.lastRetro!.id).toBe(r.id);
    expect(next.history.threads).toBe(0);
    // At every retro, the periods to choose from: those that read the last retro's threads again say so.
    expect(next.options.map((o) => [o.label, o.flag, o.threads, o.proposed, o.overlapsLastRetro])).toEqual([
      ['since the last retro', '', 0, true, false],
      ['last 30 days', '--since 30d', 1, false, true],
      ['whole history', '--all', 1, false, true],
    ]);
    expect(next.options[0]!.since).toBe(next.since);
    expect((await retroScope(join(base, 'work'), { env: env(), all: true })).options).toEqual([]);
    expect((await retroScope(join(base, 'work'), { env: env(), all: true })).history.threads).toBe(1);
    const given = await retroScope(join(base, 'work'), { env: env(), since: new Date('2020-01-01T00:00:00Z') });
    expect(given).toMatchObject({ source: 'given', since: '2020-01-01T00:00:00.000Z' });
  });

  it('proposes the last 7 days when nothing was commented yet', async () => {
    await mkdir(join(base, 'empty'));
    const s = await retroScope(join(base, 'empty'), { env: env() });
    expect(s.options[0]!.since).toBe(s.since);
    expect(s.options.every((o) => o.threads === 0)).toBe(true);
  });
});

describe('what the agents read', () => {
  it('gives every thread, the preferences, the statistics and the previous retros', async () => {
    const api = new Store(join(base, 'api'));
    const t1 = await api.createThread(anchor(), { author: 'user', body: 'Amounts are cents', reviewId: null });
    const t2 = await api.createThread(anchor({ range: null }), {
      author: 'user',
      body: 'Whole file note',
      reviewId: null,
    });
    const book = new RetroBook(join(base, 'api'));
    const before = await book.start({
      root: join(base, 'api'),
      since: null,
      until: at(0),
      stores: [],
      threads: [],
      bytes: 0,
    });
    const proposals = checkProposals(
      {
        proposals: [
          {
            column: 'improve',
            subject: 'Dates are UTC',
            file: 'CLAUDE.md',
            change: 'x',
            why: 'y',
            causes: ['z'],
            evidence: [t1.id, t2.id],
            target: 'user',
            confidence: 0.5,
          },
        ],
      },
      { threads: new Map((await api.loadHistory()).threads.map((t) => [t.id, t])), labels: {}, exclusions: [] },
    );
    await book.record(before.id, [
      { type: 'retro.feedback', body: 'Helped' },
      {
        type: 'retro.proposed',
        proposals: proposals.proposals,
        watch: [{ id: 'w1', subject: 'Exports', why: '', evidence: [] }],
        dropped: [],
      },
      { type: 'retro.decided', proposal: 'p1', decision: 'excluded', note: 'not now' },
      { type: 'retro.finished' },
    ]);
    const previous = await book.list();
    expect(exclusionsOf(previous).map((x) => x.subject)).toEqual(['Dates are UTC']);

    const r = await book.start({
      root: join(base, 'api'),
      since: null,
      until: new Date().toISOString(),
      stores: [{ root: join(base, 'api'), origin: 'root', threads: 2, bytes: 1 }],
      threads: [t1.id, t2.id],
      bytes: 1,
    });
    await book.record(r.id, [
      {
        type: 'retro.classified',
        by: 'haiku',
        labels: { [t1.id]: { category: 2, missingRule: 0.1, ignoredRule: 0.9 } },
      },
    ]);
    const now = (await book.get(r.id)) as RetroState;
    const { threads, history } = await retroThreads(now, env());
    expect(history.threads).toBe(2);
    expect(threads.size).toBe(2);
    const text = analysisInput({
      retro: now,
      threads,
      previous,
      preferences: [{ id: 'P1', body: 'Short', at: at(0) }],
    });
    expect(text).toContain('- P1: Short');
    expect(text).toContain('Feedback of the user on the retro before it: Helped');
    expect(text).toContain('p1 [improve] Dates are UTC → excluded; note: not now; change: x');
    expect(text).toContain('watched: Exports');
    expect(text).toContain(`${before.id}/p1: Dates are UTC (excluded`);
    expect(text).toContain('Classification (indicative): existing rule not followed 1');
    expect(text).toContain('classified: 2 existing rule not followed · missing rule 0.10 · ignored rule 0.90');
    expect(text).toContain('Amounts are cents');
    expect(text).toContain('src/a.ts (whole file)');
    const first = analysisInput({ retro: now, threads, previous: [], preferences: [] });
    expect(first).toContain('None: this is the first retro of the project.');
    expect(first).toContain('None yet.');
    const classify = classifyInput(now, threads);
    expect(classify).toContain('14 not a defect');
    expect(classify).toContain(`THREAD ${t1.id}`);
  });
});

describe('the Jev key', () => {
  const keyFile = () => join(base, 'home', '.config', 'local-review', 'jev-key');

  it('is checked without being read: present, private, in no repository', async () => {
    expect(await jevKeyStatus(env())).toMatchObject({ source: 'none', exists: false, ok: false, path: keyFile() });
    expect(await jevKeyStatus({ ...env(), JEV_API_KEY: 'k' })).toMatchObject({ source: 'env', ok: true });
    await mkdir(join(keyFile(), '..'), { recursive: true });
    await writeFile(keyFile(), 'secret\n');
    await chmod(keyFile(), 0o644);
    const open = await jevKeyStatus(env());
    expect(open).toMatchObject({ source: 'file', mode: '644', private: false, ok: false });
    expect(open.fixes).toEqual([`chmod 600 "${keyFile()}"`]);
    await chmod(keyFile(), 0o600);
    expect(await jevKeyStatus(env())).toMatchObject({ mode: '600', private: true, inRepo: null, ok: true, fixes: [] });
    git(join(base, 'home'), 'init', '-q');
    const inRepo = await jevKeyStatus(env());
    expect(inRepo).toMatchObject({ ok: false, inRepo: join(base, 'home') });
    expect(inRepo.fixes[0]).toContain('move it out of the repository');
  });

  it('is set up by a command the user runs in their terminal', () => {
    const cmd = jevKeySetupCommand();
    expect(cmd).toContain('stty -echo');
    // Interrupted (Ctrl+C), it gives the terminal its echo back.
    expect(cmd).toContain('trap "stty echo; echo; exit 130" INT TERM');
    expect(cmd).toContain('umask 077');
    expect(cmd).toContain('chmod 600 "$HOME/.config/local-review/jev-key"');
  });
});

it('reads the threads of a retro from its project, whatever their store', async () => {
  const store = new Store(join(base, 'p'));
  await store.createThread(anchor(), { author: 'user', body: 'One', reviewId: null });
  const h = await projectHistory(join(base, 'p'), { env: env() });
  expect(h.threads).toBe(1);
  expect(created('t_x', 1).type).toBe('thread.created');
});

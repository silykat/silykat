import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  arbiterInput,
  buildAnchorContext,
  checkFindings,
  checkProposals,
  findingsFormat,
  renderUsage,
  RetroBook,
  sourceInput,
  threadHistory,
  toolOfFile,
  type AdoptedChange,
  type Anchor,
  type GuardContext,
  type SetupUsage,
  type ThreadEvent,
  type ThreadHistory,
  type ToolUsage,
} from '../src/index';

let base: string;
beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'lr-retro-findings-')));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const FILE = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
const anchor = (): Anchor => ({
  path: 'src/a.ts',
  source: 'worktree',
  ref: null,
  sha: null,
  ...buildAnchorContext(FILE, { startLine: 3, endLine: 4 }),
});
const at = (minute: number) => `2026-09-26T10:${String(minute).padStart(2, '0')}:00.000Z`;

function thread(id: string, body: string): ThreadHistory {
  const events: ThreadEvent[] = [
    { v: 1, type: 'thread.created', at: at(0), by: 'user', threadId: id, anchor: anchor() },
    { v: 1, type: 'comment.added', at: at(1), by: 'user', commentId: 'c1', body, reviewId: null },
  ];
  return threadHistory(events)!;
}

const T1 = 't_00000000000000000000000001';
const T2 = 't_00000000000000000000000002';

const tool = (over: Partial<ToolUsage>): ToolUsage => ({
  kind: 'skill',
  name: 'specs',
  scope: 'project',
  file: '/work/.claude/skills/specs/SKILL.md',
  path: '/work/.claude/skills/specs',
  byUser: 0,
  byAgent: 0,
  sessions: 0,
  lastUsed: null,
  ...over,
});

const usage: SetupUsage = {
  source: 'Claude Code',
  tools: [
    tool({}),
    tool({
      kind: 'command',
      name: 'deploy',
      file: '/work/.claude/commands/deploy.md',
      path: '/work/.claude/commands/deploy.md',
      byUser: 3,
      sessions: 2,
      lastUsed: '2026-09-25T10:00:00.000Z',
    }),
    tool({
      kind: 'agent',
      name: 'reviewer',
      scope: 'user',
      file: '/home/me/.claude/agents/reviewer.md',
      path: '/home/me/.claude/agents/reviewer.md',
    }),
  ],
  windows: [
    { scope: 'project', sessions: 12, since: '2026-09-01T10:00:00.000Z', keptDays: 30 },
    { scope: 'user', sessions: 40, since: '2026-09-02T10:00:00.000Z', keptDays: 30 },
  ],
};

const ctx = (over: Partial<GuardContext> = {}): GuardContext => ({
  threads: new Map([
    [T1, thread(T1, 'Dates are UTC here')],
    [T2, thread(T2, 'UTC, again')],
  ]),
  labels: {},
  exclusions: [],
  sessions: new Map([
    [
      'sess-1',
      {
        start: '2026-09-20T10:00:00.000Z',
        summary: null,
        report: { text: 'The user asked for UTC dates twice.', moments: new Set(['u-1']), summary: 'UTC' },
      },
    ],
  ]),
  ...over,
});

describe('the findings of each source', () => {
  it('of the threads: one cause each, threads of the period, and the check of the last changes', () => {
    const adopted: AdoptedChange = {
      retro: 'rt_X',
      proposal: 'p1',
      column: 'improve',
      subject: 'UTC',
      title: 'Say dates are UTC',
      kind: 'rule',
      change: '- UTC',
      decision: 'accepted',
      files: ['CLAUDE.md'],
      before: { threads: 2, total: 10 },
      evidence: [],
    };
    const r = checkFindings(
      {
        findings: [
          {
            subject: 'Dates',
            cause: 'the UTC convention is not written',
            evidence: [{ thread: T1, excerpt: 'UTC here' }, { thread: T2 }, { thread: 't_gone' }],
            column: 'To improve',
            kind: 'rule',
            target: 'project-shared',
            targetEvidence: [T1, 't_gone'],
            confidence: 0.9,
            note: 'twice',
          },
          { subject: 'Two', causes: ['a', 'b'], evidence: [T1], confidence: 0.5 },
          { subject: 'Nothing', cause: 'x', evidence: ['t_gone'], confidence: 2, column: 'later' },
          { subject: 'Kinds', cause: 'x', evidence: [T1], confidence: 0.5, kind: 'poem', target: 'team' },
          'not an object',
        ],
        verify: [{ change: 'rt_X/p1', threads: [T1], note: 'still' }],
      },
      'threads',
      ctx({ adopted: [adopted] }),
    );
    expect(r.findings).toEqual([
      expect.objectContaining({
        id: 'T1',
        source: 'threads',
        cause: 'the UTC convention is not written',
        column: 'improve',
        kind: 'rule',
        target: 'project-shared',
        targetEvidence: [T1],
        evidence: [
          { thread: T1, excerpt: 'UTC here' },
          { thread: T2, excerpt: '' },
        ],
        sessions: [],
        audit: null,
        note: 'twice',
      }),
    ]);
    expect(r.rejected.map((x) => [x.index, x.reasons])).toEqual([
      [2, ['one cause per finding: split it into one finding per cause']],
      [
        3,
        [
          '"confidence" must be a number from 0 to 1',
          '"column" must be one of keep, remove, improve',
          '"evidence" needs at least one thread of the period, with an excerpt: copy its id exactly',
        ],
      ],
      [
        4,
        [
          '"kind" must be one of rule, hook, skill, command, agent, doc, setting, other',
          '"target" must be one of project-shared, project-personal, user',
        ],
      ],
      [5, ['not an object']],
    ]);
    expect(r.notes).toContain('Dates: thread t_gone is not in the period, left out');
    expect(r.verifications).toEqual([
      expect.objectContaining({ after: { threads: 1, total: 2, ids: [T1] }, verdict: 'not-decreased', note: 'still' }),
    ]);
    // Every adopted change must be checked.
    expect(checkFindings({ findings: [] }, 'threads', ctx({ adopted: [adopted] })).rejected[0]!.subject).toBe(
      'check of rt_X/p1',
    );
    expect(checkFindings({}, 'threads', ctx()).rejected[0]!.reasons).toEqual([
      'expected a JSON object with a "findings" array',
    ]);
  });

  it('of the sessions: words and moments of their reports, and the overview', () => {
    const r = checkFindings(
      {
        findings: [
          {
            subject: 'UTC',
            cause: 'no rule',
            sessions: [{ session: 'sess-1', excerpt: 'asked for UTC dates', moments: ['u-1'] }, 'sess-unknown'],
            confidence: 0.6,
          },
          { subject: 'Invented', cause: 'x', sessions: [{ session: 'sess-1', excerpt: 'loved it' }], confidence: 0.5 },
          { subject: 'None', cause: 'x', confidence: 0.5 },
        ],
        overview: { summary: 'Dates.', items: [{ kind: 'friction', title: 'UTC', sessions: ['sess-1'] }] },
      },
      'sessions',
      ctx(),
    );
    expect(r.findings).toEqual([
      expect.objectContaining({
        id: 'S1',
        sessions: [
          { session: 'sess-1', start: '2026-09-20T10:00:00.000Z', excerpt: 'asked for UTC dates', moments: ['u-1'] },
        ],
      }),
    ]);
    expect(r.rejected.map((x) => x.reasons[0])).toEqual([
      'the excerpt of session sess-1 is not in its summary or report: copy their words exactly ("loved it")',
      '"sessions" needs at least one session the retro reads, with words copied from it',
    ]);
    expect(r.notes).toContain('UTC: session sess-unknown is not one the retro reads, left out');
    expect(r.overview).toEqual({
      summary: 'Dates.',
      items: [{ kind: 'friction', title: 'UTC', description: '', sessions: ['sess-1'] }],
    });
  });

  it('of the audit: where the audit saw it, and what', () => {
    const r = checkFindings(
      {
        findings: [
          {
            subject: 'Stale skill',
            cause: 'it names a script that is gone',
            audit: { location: '.claude/skills/specs/SKILL.md:3', finding: 'stale' },
            file: '.claude/skills/specs/SKILL.md',
            change: 'Fixed text',
            confidence: 0.8,
          },
          { subject: 'No place', cause: 'x', audit: { finding: 'stale' }, confidence: 0.8 },
        ],
      },
      'audit',
      ctx(),
    );
    expect(r.findings[0]).toMatchObject({ id: 'A1', audit: { location: '.claude/skills/specs/SKILL.md:3' } });
    expect(r.rejected[0]!.reasons).toEqual([
      '"audit" needs a "location" and a "finding": where the audit saw it, and what',
    ]);
  });

  it('are asked in one common format, with what is proper to each source', () => {
    const threads = findingsFormat('threads').join('\n');
    expect(threads).toContain('"evidence": [{ "thread": "t_…"');
    expect(threads).toContain('"verify"');
    expect(threads).not.toContain('"overview"');
    const sessions = findingsFormat('sessions').join('\n');
    expect(sessions).toContain('"moments"');
    expect(sessions).toContain('"overview"');
    expect(findingsFormat('audit').join('\n')).toContain('"audit": { "location"');
  });
});

describe('the tools of the setup never used', () => {
  it('are found from the file a proposal names', () => {
    const tools = usage.tools;
    expect(toolOfFile('.claude/skills/specs/SKILL.md', tools, '/work')?.name).toBe('specs');
    expect(toolOfFile('.claude/skills/specs/scripts/run.sh:2-3', tools, '/work')?.name).toBe('specs');
    expect(toolOfFile('/work/.claude/commands/deploy.md', tools, '/elsewhere')?.name).toBe('deploy');
    expect(toolOfFile('~/.claude/agents/reviewer.md', tools, '/work', '/home/me')?.name).toBe('reviewer');
    expect(toolOfFile('CLAUDE.md', tools, '/work')).toBeNull();
    expect(toolOfFile('.claude/skills/specs-old/SKILL.md', tools, '/work')).toBeNull();
  });

  it('turn a finding of the audit into a question: keep it, or remove it?', () => {
    const proposal = (file: string, column = 'improve') => ({
      column,
      subject: `Fix ${file}`,
      title: `Fix ${file}`,
      kind: 'skill',
      file,
      rule: 'old text',
      change: column === 'improve' ? 'new text' : 'Remove it',
      why: 'stale',
      causes: ['stale'],
      evidence: [],
      target: 'project-shared',
      confidence: 0.8,
      audit: { location: `${file}:1`, finding: 'stale' },
    });
    const r = checkProposals(
      {
        proposals: [
          proposal('.claude/skills/specs/SKILL.md'),
          proposal('.claude/commands/deploy.md'),
          proposal('~/.claude/agents/reviewer.md', 'remove'),
          proposal('CLAUDE.md'),
        ],
      },
      ctx({ usage: { ...usage, root: '/work', home: '/home/me' } }),
    );
    expect(r.rejected).toEqual([]);
    const [skill, command, agent, rules] = r.proposals;
    expect(skill).toMatchObject({
      column: 'remove',
      change: 'Remove the skill specs: /work/.claude/skills/specs',
      unused: {
        kind: 'skill',
        name: 'specs',
        scope: 'project',
        path: '/work/.claude/skills/specs',
        fix: 'new text',
        sessions: 12,
        since: '2026-09-01T10:00:00.000Z',
        keptDays: 30,
      },
    });
    expect(command!.unused).toBeUndefined(); // used: fixed as usual
    expect(command!.column).toBe('improve');
    expect(agent!.unused).toMatchObject({ kind: 'agent', scope: 'user', fix: '', sessions: 40 });
    expect(rules!.unused).toBeUndefined();
    expect(r.notes).toContain(
      'Fix .claude/skills/specs/SKILL.md: the skill specs was never used, asked whether to keep it or remove it',
    );
    // No session to count on: nothing tells it is unused.
    const none = checkProposals(
      { proposals: [proposal('.claude/skills/specs/SKILL.md')] },
      ctx({ usage: { ...usage, windows: [{ ...usage.windows[0]!, sessions: 0 }], root: '/work' } }),
    );
    expect(none.proposals[0]!.unused).toBeUndefined();
    // Without the usage, nothing changes.
    expect(
      checkProposals({ proposals: [proposal('.claude/skills/specs/SKILL.md')] }, ctx()).proposals[0],
    ).toMatchObject({ column: 'improve' });
  });

  it('are listed for the reading of the audit, the never used first', () => {
    const text = renderUsage(usage).join('\n');
    expect(text).toContain("the project's tools on its 12 session(s) since 2026-09-01");
    expect(text).toContain("the user's tools on every project's 40 session(s)");
    expect(text).toContain('Sessions inactive for more than 30 days are deleted by the agent');
    expect(text.indexOf('skill specs')).toBeLessThan(text.indexOf('command deploy'));
    expect(text).toContain('- skill specs (project, /work/.claude/skills/specs/SKILL.md): NEVER USED');
    expect(text).toContain('used 3 time(s) (3 typed by the user, 0 by the agent) in 2 session(s), last 2026-09-25');
    expect(renderUsage(null).join('\n')).toContain('Not counted.');
    expect(renderUsage({ ...usage, tools: [] }).join('\n')).toContain('No skill, command or sub-agent in the setup.');
  });
});

describe('the inputs of the analysis, one source at a time', () => {
  it('give each source to its own agent, then the findings of all of them to the analysis', async () => {
    const book = new RetroBook(base);
    const r = await book.start({
      root: '/work',
      since: null,
      until: '2026-09-30T00:00:00.000Z',
      stores: [],
      threads: [T1, T2],
      bytes: 0,
      sessionsMode: 'reports',
    });
    expect(r.sessionsMode).toBe('reports');
    const c = ctx();
    const analysis = {
      retro: r,
      threads: new Map([...c.threads].map(([id, t]) => [id, { thread: t, store: '/work' }])),
      previous: [],
      preferences: [{ id: 'P1', body: 'Short proposals.', at: at(0) }],
    };
    const threads = sourceInput(analysis, 'threads');
    expect(threads).toContain('# Retro input: the review threads');
    expect(threads).toContain('- P1: Short proposals.');
    expect(threads).toContain(`THREAD ${T1}`);
    expect(threads).toContain('"verify"');
    expect(sourceInput(analysis, 'sessions')).toContain('None: the retro reads no session.');
    const audit = sourceInput(analysis, 'audit', { audit: '# Audit\nA stale skill.', usage });
    expect(audit).toContain('A stale skill.');
    expect(audit).toContain('NEVER USED');
    expect(audit).not.toContain(`THREAD ${T1}`);
    expect(sourceInput(analysis, 'audit')).toContain('None: the audit did not run.');

    // The journal keeps what each source showed, and how much the tools were used.
    const t = checkFindings(
      { findings: [{ subject: 'Dates', cause: 'no rule', evidence: [T1, T2], confidence: 0.9 }] },
      'threads',
      c,
    );
    const a = checkFindings(
      {
        findings: [
          {
            subject: 'Stale skill',
            cause: 'stale',
            audit: { location: '.claude/skills/specs/SKILL.md:3', finding: 'stale' },
            file: '.claude/skills/specs/SKILL.md',
            confidence: 0.8,
          },
        ],
      },
      'audit',
      c,
    );
    const sessions = checkFindings(
      {
        findings: [
          {
            subject: 'UTC',
            cause: 'no rule',
            sessions: [{ session: 'sess-1', excerpt: 'asked for UTC dates', moments: ['u-1'] }],
            rule: 'An old rule',
            change: 'A new rule',
            target: 'project-shared',
            confidence: 0.6,
            note: 'every session',
          },
        ],
        overview: { summary: 'Dates.', items: [] },
      },
      'sessions',
      c,
    );
    await book.record(r.id, [
      {
        type: 'retro.findings',
        source: 'threads',
        findings: t.findings,
        verifications: [
          {
            retro: 'rt_X',
            proposal: 'p1',
            column: 'improve',
            subject: 'UTC',
            title: 'Say dates are UTC',
            kind: 'rule',
            change: '- UTC',
            decision: 'accepted',
            files: [],
            before: { threads: 2, total: 10 },
            evidence: [],
            after: { threads: 1, total: 2, ids: [T1] },
            verdict: 'not-decreased',
            note: 'still',
          },
        ],
      },
      { type: 'retro.findings', source: 'sessions', findings: sessions.findings, overview: sessions.overview! },
      { type: 'retro.findings', source: 'audit', findings: a.findings },
      { type: 'retro.usage', ...usage },
    ]);
    const after = await book.get(r.id);
    expect(after.findings.threads?.findings).toHaveLength(1);
    expect(after.usage?.tools).toHaveLength(3);

    const text = arbiterInput(
      analysis,
      after.findings,
      { threads: '/x/threads-input.md', audit: '/x/audit-input.md' },
      after.usage,
    );
    expect(text).toContain('## Findings: the review threads');
    expect(text).toContain('### T1 · Dates');
    expect(text).toContain(`- thread ${T1}`);
    expect(text).toContain(
      `- rt_X/p1 Say dates are UTC: 2 of 10 threads before, 1 of 2 since → not-decreased (${T1}); still`,
    );
    expect(text).toContain('- session sess-1: "asked for UTC dates" (moments u-1)');
    expect(text).toContain('- existing: An old rule');
    expect(text).toContain('- suggested change: A new rule');
    expect(text).toContain('- target: project-shared');
    expect(text).toContain('- confidence: 0.6 · every session');
    expect(text).toContain('### What recurs across the sessions (prepared by the reading of the sessions)');
    expect(arbiterInput(analysis, { threads: { source: 'threads', findings: [] } }, {}, null)).toContain(
      "## Findings: the agent's sessions\n\nNot read (no such source in this retro).",
    );
    expect(text).toContain('- usage: skill specs NEVER USED (the user will be asked whether to keep it or remove it)');
    expect(text).toContain('- The threads, every one of them: /x/threads-input.md');
    expect(text).not.toContain(`THREAD ${T1}`); // the sources stay in their files
  });
});

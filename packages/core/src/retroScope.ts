import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { deletionLabel, type HistoryEntry, type ThreadHistory } from './history';
import { projectHistory, type ProjectHistory } from './project';
import { renderSessions, type RetroSession } from './retroSessions';
import { findingsFormat, type Finding, type FindingSource, type SourceFindings } from './retroFindings';
import { TOOL_TITLE, toolOfFile, usesOf, type SetupUsage } from './retroUsage';
import { renderSessionReports, type SessionReport } from './sessionReports';
import {
  FEEDBACK_CATEGORIES,
  RetroBook,
  retroHome,
  type AdoptedChange,
  type Preference,
  type RetroState,
  type ThreadLabel,
} from './retro';
import {
  adoptedChanges,
  changeRef,
  exclusionsOf,
  retroStats,
  threadSignals,
  type Exclusion,
  type RetroStats,
} from './retroGuards';

/** How the period of a retro was chosen. */
export type PeriodSource = 'last-retro' | 'given' | 'proposed' | 'all';

/** A period offered for a retro, with what it holds. */
export interface PeriodOption {
  label: string;
  /** `null`: the whole history. */
  since: string | null;
  /** How to ask for it: `--since 7d`, `--all`; empty for the period of the last retro on (the default). */
  flag: string;
  threads: number;
  bytes: number;
  /** The period proposed: the one a retro covers when none is asked for. */
  proposed: boolean;
  /** It starts before the end of the last retro: it reads again threads that retro read. */
  overlapsLastRetro: boolean;
}

/** Rough durations, in seconds: they are announced to the user before anything is spent. */
export interface RetroEstimate {
  tokens: number;
  classifyJev: number;
  classifyModel: number;
  analysis: number;
}

export interface RetroScope {
  root: string;
  /** The folder whose store keeps the retros. */
  home: string;
  since: string | null;
  until: string;
  source: PeriodSource;
  history: ProjectHistory;
  estimate: RetroEstimate;
  lastRetro: RetroState | null;
  /** Retros started and never finished. */
  unfinished: RetroState[];
  preferences: Preference[];
  /** The periods to choose from (none when a period is asked for), the proposed one first. */
  options: PeriodOption[];
  /** The changes adopted at the last retro, that this one will check. */
  toVerify: AdoptedChange[];
}

const DAY = 86_400_000;

/**
 * What a retro of the project `root` would cover: since the last finished retro, or `since` when
 * given (`null` with `all`). A first retro proposes the last 7 days (a retro a week), or longer
 * when they hold nothing. Without a period asked for, it lists the periods to choose from, with what
 * each holds: since the last retro (when there is one), the last 7 days (first retro) or 30 days,
 * and the whole history.
 */
export async function retroScope(
  root: string,
  opts: { since?: Date | null; all?: boolean; env?: Record<string, string | undefined>; now?: number } = {},
): Promise<RetroScope> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  const dir = resolve(root);
  const home = await retroHome(dir, env);
  const book = new RetroBook(home);
  const retros = (await book.list()).filter((r) => r.root === dir);
  const lastRetro = retros.filter((r) => r.finishedAt !== null).at(-1) ?? null;
  const unfinished = retros.filter((r) => r.finishedAt === null);
  // Just after the last retro: what it read is not read again.
  const afterLast = lastRetro ? Date.parse(lastRetro.until) + 1 : null;

  let options: PeriodOption[] = [];
  let since: Date | null;
  let source: PeriodSource;
  if (opts.all) [since, source] = [null, 'all'];
  else if (opts.since) [since, source] = [opts.since, 'given'];
  else {
    const whole = await projectHistory(dir, { env });
    const threads = whole.stores.flatMap((s) => s.threads);
    const option = (label: string, from: number | null, flag: string): PeriodOption => {
      const ts = from === null ? threads : threads.filter((t) => Date.parse(t.lastActivityAt) >= from);
      return {
        label,
        since: from === null ? null : new Date(from).toISOString(),
        flag,
        threads: ts.length,
        bytes: ts.reduce((n, t) => n + t.bytes, 0),
        proposed: false,
        overlapsLastRetro: afterLast !== null && (from === null || from < afterLast),
      };
    };
    const days = (n: number) => option(`last ${n} days`, now - n * DAY, `--since ${n}d`);
    options = [
      ...(afterLast !== null ? [option('since the last retro', afterLast, '')] : [days(7)]),
      days(30),
      option('whole history', null, '--all'),
    ];
    const pick = afterLast !== null ? options[0]! : (options.find((o) => o.threads > 0) ?? options[0]!);
    pick.proposed = true;
    options = [pick, ...options.filter((o) => o !== pick)];
    since = pick.since ? new Date(pick.since) : null;
    source = afterLast !== null ? 'last-retro' : 'proposed';
  }
  const history = await projectHistory(dir, { since, env });
  return {
    root: dir,
    home,
    since: history.since,
    until: new Date(now).toISOString(),
    source,
    history,
    estimate: estimate(history),
    lastRetro,
    unfinished,
    preferences: await book.preferences(),
    options,
    toVerify: lastRetro ? adoptedChanges(lastRetro) : [],
  };
}

/**
 * The changes a retro checks: those adopted at the last retro of the same project finished before
 * it started (`previous`: the other retros of its book).
 */
export function changesToVerify(retro: RetroState, previous: readonly RetroState[]): AdoptedChange[] {
  const last = previous
    .filter((r) => r.root === retro.root && r.finishedAt !== null && r.finishedAt <= retro.startedAt)
    .at(-1);
  return last ? adoptedChanges(last) : [];
}

/** About 4 characters per token. */
const tokensOf = (chars: number) => Math.ceil(chars / 4);

/**
 * Durations, from the measures made while designing and building the retro: Jev classifies a
 * thread in 0.8 s (4 requests at a time here); a small model in a sub-agent took a minute for 13
 * threads; the analysis reads about 1,000 tokens a second, plus the time to start and to check
 * its proposals. Rough figures, to be refined on real retros.
 */
export function estimate(h: ProjectHistory): RetroEstimate {
  const threads = h.stores.flatMap((s) => s.threads);
  const tokens = tokensOf(threads.reduce((n, t) => n + threadText(t).length, 0));
  return {
    tokens,
    classifyJev: Math.round(10 + threads.length * 0.25),
    classifyModel: Math.round(45 + threads.length),
    analysis: Math.round(60 + tokens / 1000),
  };
}

const who = (by: string, agent?: string) => (by === 'user' ? 'User' : (agent ?? 'Agent'));

function entryText(e: HistoryEntry): string {
  switch (e.kind) {
    case 'comment': {
      const notes = [e.publishedAt ?? e.at];
      if (e.editedAt) notes.push(`edited ${e.editedAt}`);
      if (e.deletedAt) notes.push(`deleted ${e.deletedAt}`);
      return `[${who(e.author, e.agent)}] (${notes.join(', ')}) ${e.body}`;
    }
    case 'status':
      return `(status -> ${e.status} by ${who(e.by, e.agent)}, ${e.at})`;
    case 'deleted':
      return `(thread deleted, ${deletionLabel(e.reason)}, ${e.at})`;
  }
}

/** A thread as the retro's agents read it: where, the code, the conversation. */
export function threadText(t: ThreadHistory, store?: string): string {
  const a = t.anchor;
  const where = a.range ? `${a.path}:${a.range.startLine}-${a.range.endLine}` : `${a.path} (whole file)`;
  const lines = [
    `THREAD ${t.id} · ${where} · ${t.state}` +
      (store ? ` · store ${store}` : '') +
      (t.branch ? ` · branch ${t.branch.branch}` : ''),
  ];
  if (a.range && a.snippet) lines.push('code:', ...a.snippet.split('\n').map((l) => `  ${l}`));
  for (const e of t.conversation) lines.push(entryText(e));
  return lines.join('\n');
}

/** The threads a retro reads, from its project's history. */
export async function retroThreads(
  retro: RetroState,
  env: Record<string, string | undefined> = process.env,
): Promise<{ history: ProjectHistory; threads: Map<string, { thread: ThreadHistory; store: string }> }> {
  const history = await projectHistory(retro.root, { since: retro.since ? new Date(retro.since) : null, env });
  const wanted = new Set(retro.threads);
  const threads = new Map<string, { thread: ThreadHistory; store: string }>();
  for (const s of history.stores)
    for (const t of s.threads)
      if (wanted.has(t.id))
        threads.set(t.id, {
          thread: t,
          store: s.saved ? `${s.root} (saved before its git worktree was removed)` : s.root,
        });
  return { history, threads };
}

const label = (l: ThreadLabel | undefined): string =>
  l
    ? `classified: ${l.category} ${FEEDBACK_CATEGORIES[l.category]?.split(':')[0] ?? '?'}` +
      (l.missingRule !== undefined ? ` · missing rule ${l.missingRule.toFixed(2)}` : '') +
      (l.ignoredRule !== undefined ? ` · ignored rule ${l.ignoredRule.toFixed(2)}` : '')
    : '';

/** The input of the classification step: the categories, then every thread. */
export function classifyInput(
  retro: RetroState,
  threads: ReadonlyMap<string, { thread: ThreadHistory; store?: string }>,
): string {
  const grid = Object.entries(FEEDBACK_CATEGORIES)
    .map(([n, d]) => `${n} ${d}`)
    .join('\n');
  return [
    `# Classification input — retro ${retro.id}`,
    `${threads.size} threads. For each one, give:`,
    '- "category": the ONE category below that best explains why the developer commented (the root cause, not the symptom);',
    '- "missingRule" (0 to 1): does the feedback reveal a constraint, convention or fact specific to this project (not general good practice) that the rules files do not state?',
    '- "ignoredRule" (0 to 1): does the feedback point to something the rules files already state, that the agent did not follow?',
    '- "confidence" (0 to 1) in the category.',
    '',
    '## Categories',
    grid,
    '',
    '## Threads',
    ...[...threads.values()].map(({ thread, store }) => threadText(thread, store) + '\n'),
  ].join('\n');
}

export interface AnalysisContext {
  retro: RetroState;
  threads: ReadonlyMap<string, { thread: ThreadHistory; store: string }>;
  previous: readonly RetroState[];
  preferences: readonly Preference[];
  /** The agent's sessions of the project and of the period, when its adapter found them. */
  sessions?: readonly RetroSession[];
  /** The reports on those sessions, when its adapter wrote them, and the folder they are kept in. */
  reports?: { list: readonly SessionReport[]; dir: string };
}

/** Numbers of the period, without a model. */
export function statsOf(ctx: Pick<AnalysisContext, 'retro' | 'threads'>): RetroStats {
  return retroStats(
    [...ctx.threads.values()].map((x) => x.thread),
    ctx.retro.classification?.labels,
  );
}

function renderStats(s: RetroStats): string[] {
  const lines = [
    `- ${s.threads} threads; reopened after the agent said it was done: ${s.reopened}; the agent asked a question: ${s.questions}; back-and-forth (the user replied again after the agent): ${s.backAndForth}; deleted: ${s.deleted} (removed by the user: ${s.deletedByUser}; with their branch, once the work was done: ${s.deletedWithBranch}; older, reason unknown: ${s.deleted - s.deletedByUser - s.deletedWithBranch}).`,
  ];
  const cats = Object.entries(s.categories).sort((a, b) => b[1] - a[1]);
  if (cats.length > 0)
    lines.push(
      `- Classification (indicative): ${cats.map(([c, n]) => `${FEEDBACK_CATEGORIES[Number(c)]?.split(':')[0]} ${n}`).join(', ')}.`,
      `- Flagged as a possibly missing project rule: ${s.missingRule}; as a possibly ignored existing rule: ${s.ignoredRule}.`,
    );
  return lines;
}

function renderPrevious(previous: readonly RetroState[], exclusions: readonly Exclusion[]): string[] {
  if (previous.length === 0) return ['None: this is the first retro of the project.'];
  const out: string[] = [];
  for (const r of previous) {
    out.push(`### Retro ${r.id} (${r.since?.slice(0, 10) ?? 'start'} to ${r.until.slice(0, 10)})`);
    for (const f of r.feedback) out.push(`- Feedback of the user on the retro before it: ${f}`);
    for (const p of r.proposals) {
      const d = r.decisions[p.id];
      const files = r.applied[p.id]?.join(', ');
      out.push(
        `- ${p.id} [${p.column}] ${p.subject} → ${d ? d.decision + (d.target ? ` (target ${d.target})` : '') : 'no decision'}` +
          (d?.note ? `; note: ${d.note}` : '') +
          (files ? `; changed: ${files}` : '') +
          (p.change ? `; change: ${p.change.replace(/\s+/g, ' ').slice(0, 300)}` : ''),
      );
    }
    for (const w of r.watch) out.push(`- watched: ${w.subject} (${w.evidence.map((e) => e.thread).join(', ')})`);
  }
  if (exclusions.length > 0) {
    out.push(
      '',
      'Excluded subjects: never propose them again, unless at least 2 NEW threads raise them (then set "reopens" to "<retro>/<proposal>"):',
    );
    for (const x of exclusions) out.push(`- ${x.retro}/${x.proposal}: ${x.subject} (excluded ${x.at.slice(0, 10)})`);
  }
  return out;
}

/** The head of every input of the analysis: the retro, the user's preferences, the previous retros. */
function inputHead(title: string, ctx: AnalysisContext): string[] {
  const { retro, threads } = ctx;
  const prefs = ctx.preferences.length ? ctx.preferences.map((p) => `- ${p.id}: ${p.body}`) : ['None yet.'];
  return [
    `# ${title} — ${retro.root}`,
    `Retro ${retro.id}. Period: ${retro.since ?? 'the whole history'} to ${retro.until}. ${threads.size} threads, from ${retro.stores.length} comment store(s): ${retro.stores.map((s) => s.root).join(', ')}.`,
    '',
    "## The user's retro preferences (apply them)",
    ...prefs,
    '',
    '## Previous retros',
    ...renderPrevious(ctx.previous, exclusionsOf(ctx.previous)),
    '',
  ];
}

/** Every thread of the period, with its classification and signals. */
function renderThreads(ctx: AnalysisContext): string[] {
  const labels = ctx.retro.classification?.labels ?? {};
  return [
    `## Threads (all ${ctx.threads.size} of them, oldest first)`,
    '',
    ...[...ctx.threads.values()].map(({ thread, store }) => {
      const sig = threadSignals(thread);
      const extra = [
        label(labels[thread.id]),
        sig.reopened ? 'reopened' : '',
        sig.question ? 'agent asked' : '',
        sig.rounds ? `${sig.rounds} round(s) of back-and-forth` : '',
        linkedSessions(thread).length ? "the agent's conversation is linked" : '',
      ].filter(Boolean);
      return threadText(thread, store) + (extra.length ? `\n(${extra.join(' · ')})` : '') + '\n';
    }),
  ];
}

/** The agent's sessions the retro reads: their reports, or the agent's own summaries. */
function renderRetroSessions(ctx: AnalysisContext): string[] {
  return [
    ...renderSessions(ctx.sessions ?? []),
    ...(ctx.reports ? renderSessionReports(ctx.reports.list, ctx.reports.dir) : []),
  ];
}

/**
 * The input of the analysis in one go, every source together: preferences, previous retros,
 * statistics, every thread, the sessions. Used when the sources were not read by their own agents.
 */
export function analysisInput(ctx: AnalysisContext): string {
  return [
    ...inputHead('Retro input', ctx),
    ...renderToVerify(changesToVerify(ctx.retro, ctx.previous)),
    '## Statistics (computed without a model)',
    ...renderStats(statsOf(ctx)),
    '',
    ...renderThreads(ctx),
    ...renderRetroSessions(ctx),
  ].join('\n');
}

/** What a source's agent needs besides the retro: the audit's report, the usage of the setup's tools. */
export interface SourceExtras {
  /** The report of the audit of the setup, when it ran. */
  audit?: string | null;
  usage?: SetupUsage | null;
}

/** The input of the agent that reads one source of the retro, and records its findings. */
export function sourceInput(ctx: AnalysisContext, source: FindingSource, extras: SourceExtras = {}): string {
  const body: string[] = [];
  if (source === 'threads')
    body.push(
      ...renderToVerify(changesToVerify(ctx.retro, ctx.previous)),
      '## Statistics (computed without a model)',
      ...renderStats(statsOf(ctx)),
      '',
      ...renderThreads(ctx),
    );
  else if (source === 'sessions') {
    const sessions = renderRetroSessions(ctx);
    body.push(
      ...(sessions.length ? sessions : ["## The agent's sessions", '', 'None: the retro reads no session.', '']),
    );
  } else
    body.push(
      '## The audit of the setup',
      '',
      extras.audit?.trim() || 'None: the audit did not run.',
      '',
      ...renderUsage(extras.usage ?? null),
    );
  return [...inputHead(`Retro input: ${SOURCE_TITLE[source]}`, ctx), ...body, '', ...findingsFormat(source)].join('\n');
}

export const SOURCE_TITLE: Record<FindingSource, string> = {
  threads: 'the review threads',
  sessions: "the agent's sessions",
  audit: 'the audit of the setup',
};

/** How much each tool of the setup was used: the never used first. */
export function renderUsage(usage: SetupUsage | null): string[] {
  if (!usage) return ["## Usage of the setup's tools", '', 'Not counted.', ''];
  const lines = [
    "## Usage of the setup's tools (counted without a model)",
    '',
    `From ${usage.source}'s own records, on this machine only: ` +
      usage.windows
        .map(
          (w) =>
            `${w.scope === 'project' ? "the project's tools on its" : "the user's tools on every project's"} ${w.sessions} session(s)` +
            (w.since ? ` since ${w.since.slice(0, 10)}` : ''),
        )
        .join('; ') +
      `. Sessions inactive for more than ${usage.windows[0]?.keptDays ?? 30} days are deleted by the agent: older uses are not seen. A tool shared in a repository may serve the rest of the team.`,
    '',
  ];
  const sorted = [...usage.tools].sort((a, b) => usesOf(a) - usesOf(b) || a.name.localeCompare(b.name));
  for (const t of sorted)
    lines.push(
      `- ${TOOL_TITLE[t.kind]} ${t.name} (${t.scope}, ${t.file}): ` +
        (usesOf(t) === 0
          ? 'NEVER USED'
          : `used ${usesOf(t)} time(s) (${t.byUser} typed by the user, ${t.byAgent} by the agent) in ${t.sessions} session(s), last ${t.lastUsed?.slice(0, 10) ?? '?'}`),
    );
  if (sorted.length === 0) lines.push('No skill, command or sub-agent in the setup.');
  return [...lines, ''];
}

/** A finding, as the analysis reads it. */
function renderFinding(f: Finding, usage: SetupUsage | null, root: string): string[] {
  const tool = usage && f.source === 'audit' ? toolOfFile(f.file || f.audit?.location || '', usage.tools, root) : null;
  return [
    `### ${f.id} · ${f.subject}` + (f.column ? ` (suggests: ${f.column}${f.kind ? `, ${f.kind}` : ''})` : ''),
    `- cause: ${f.cause}`,
    ...f.evidence.map((e) => `- thread ${e.thread}${e.excerpt ? `: "${e.excerpt}"` : ''}`),
    ...f.sessions.map(
      (e) =>
        `- session ${e.session}${e.excerpt ? `: "${e.excerpt}"` : ''}` +
        (e.moments?.length ? ` (moments ${e.moments.join(', ')})` : ''),
    ),
    ...(f.audit ? [`- audit, ${f.audit.location}: ${f.audit.finding}`] : []),
    ...(tool
      ? [
          `- usage: ${TOOL_TITLE[tool.kind]} ${tool.name} ` +
            (usesOf(tool) === 0
              ? 'NEVER USED (the user will be asked whether to keep it or remove it)'
              : `used ${usesOf(tool)} time(s)`),
        ]
      : []),
    ...(f.file ? [`- file: ${f.file}`] : []),
    ...(f.rule ? [`- existing: ${f.rule.replace(/\s+/g, ' ').slice(0, 400)}`] : []),
    ...(f.change ? [`- suggested change: ${f.change.replace(/\s+/g, ' ').slice(0, 600)}`] : []),
    ...(f.target ? [`- target: ${f.target}${f.targetEvidence.length ? ` (${f.targetEvidence.join(', ')})` : ''}`] : []),
    `- confidence: ${f.confidence}` + (f.note ? ` · ${f.note}` : ''),
    '',
  ];
}

/** Where the analysis goes back to a source, to settle a doubt. */
export interface SourceFiles {
  threads?: string;
  sessions?: string;
  audit?: string;
}

/**
 * The input of the analysis that weighs the findings of every source against each other and writes
 * the proposals: the findings, the check of the last retro's changes, the statistics; the sources
 * themselves stay in their files, to go back to.
 */
export function arbiterInput(
  ctx: AnalysisContext,
  findings: Partial<Record<FindingSource, SourceFindings>>,
  files: SourceFiles,
  usage: SetupUsage | null,
): string {
  const lines = [...inputHead('Retro input: the findings of every source', ctx)];
  const verifications = findings.threads?.verifications ?? [];
  if (verifications.length > 0) {
    lines.push(
      '## Changes adopted at the last retro: checked by the reading of the threads',
      '',
      'Already in "verify" (copied into your proposals when you leave "verify" out). A change that did not reduce the feedback, with 2 threads or more, needs a proposal to revise it ("revisits": "<ref>").',
      '',
      ...verifications.map(
        (v) =>
          `- ${changeRef(v)} ${v.title}: ${v.before.threads} of ${v.before.total} threads before, ${v.after.threads} of ${v.after.total} since → ${v.verdict}` +
          (v.after.ids.length ? ` (${v.after.ids.join(', ')})` : '') +
          (v.note ? `; ${v.note}` : ''),
      ),
      '',
    );
  }
  lines.push('## Statistics (computed without a model)', ...renderStats(statsOf(ctx)), '');
  for (const source of FINDING_ORDER) {
    const f = findings[source];
    lines.push(`## Findings: ${SOURCE_TITLE[source]}`, '');
    if (!f) {
      lines.push('Not read (no such source in this retro).', '');
      continue;
    }
    if (f.findings.length === 0) lines.push('No finding.', '');
    for (const x of f.findings) lines.push(...renderFinding(x, usage, ctx.retro.root));
    if (f.overview)
      lines.push(
        '### What recurs across the sessions (prepared by the reading of the sessions)',
        '',
        'Copied into your proposals as "overview" when you leave it out.',
        '',
        '```json',
        JSON.stringify(f.overview, null, 1),
        '```',
        '',
      );
  }
  lines.push(
    '## The sources, to go back to',
    '',
    ...(files.threads ? [`- The threads, every one of them: ${files.threads}`] : []),
    ...(files.sessions ? [`- The agent's sessions: ${files.sessions}`] : []),
    ...(files.audit ? [`- The audit of the setup and the usage of its tools: ${files.audit}`] : []),
    '',
  );
  return lines.join('\n');
}

const FINDING_ORDER: readonly FindingSource[] = ['threads', 'sessions', 'audit'];

function renderToVerify(changes: readonly AdoptedChange[]): string[] {
  if (changes.length === 0) return [];
  const out = [
    '## Changes adopted at the last retro: did they help?',
    '',
    'For EACH change below, list in "verify" the threads of this period whose feedback has the same cause (the change did not prevent it), [] when none: { "change": "<ref>", "threads": [...], "note": "what you saw, in a sentence" }. The numbers and the verdict are computed by program: stopped (no thread), decreased (a smaller share of the threads than before) or not decreased. A change that did not reduce the feedback, with 2 threads or more, needs a proposal to revise it, with "revisits": "<ref>" (reword it, move it up, make it a hook, or remove it); its "target" defaults to the one of the change it revises.',
    '',
  ];
  for (const c of changes) {
    out.push(
      `- ${changeRef(c)} [${c.column}] ${c.title} (${c.kind}, ${c.decision}${c.target ? `, target ${c.target}` : ''}${c.files.length ? `, changed: ${c.files.join(', ')}` : ', no file recorded as changed'}): ${c.subject}`,
      `  before: ${c.before.threads} of the ${c.before.total} threads of that retro` +
        (c.change ? `; change: ${c.change.replace(/\s+/g, ' ').slice(0, 300)}` : '') +
        (c.note ? `; note of the user: ${c.note}` : ''),
      ...c.evidence.map((e) => `  - ${e.thread}${e.excerpt ? `: "${e.excerpt}"` : ''}`),
    );
  }
  out.push('');
  return out;
}

/** The agent sessions the replies of a thread were written in, as recorded (oldest first, once each). */
export function linkedSessions(t: ThreadHistory): string[] {
  const ids = t.conversation.flatMap((e) => (e.kind === 'comment' && e.session ? [e.session.id] : []));
  return [...new Set(ids)];
}

/** Writes a retro's input for its agents, and says where. */
export async function writeRetroFile(book: RetroBook, id: string, name: string, content: string): Promise<string> {
  const file = join(await book.workDir(id), name);
  await writeFile(file, content);
  return file;
}

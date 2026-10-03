import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { deletionLabel, type HistoryEntry, type ThreadHistory } from './history';
import { projectHistory, type ProjectHistory } from './project';
import { FEEDBACK_CATEGORIES, RetroBook, retroHome, type Preference, type RetroState, type ThreadLabel } from './retro';
import { exclusionsOf, retroStats, threadSignals, type Exclusion, type RetroStats } from './retroGuards';

/** How the period of a retro was chosen. */
export type PeriodSource = 'last-retro' | 'given' | 'proposed' | 'all';

/** A period offered for a first retro, with what it holds. */
export interface PeriodOption {
  label: string;
  /** `null`: the whole history. */
  since: string | null;
  /** How to ask for it: `--since 7d`, `--all`. */
  flag: string;
  threads: number;
  bytes: number;
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
  /** For a first retro: the periods to choose from. */
  options: PeriodOption[];
}

const DAY = 86_400_000;

/**
 * What a retro of the project `root` would cover: since the last finished retro, or `since` when
 * given (`null` with `all`). A first retro proposes the last 7 days (a retro a week), or longer
 * when they hold nothing.
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

  const options: PeriodOption[] = [];
  let since: Date | null;
  let source: PeriodSource;
  if (opts.all) [since, source] = [null, 'all'];
  else if (opts.since) [since, source] = [opts.since, 'given'];
  // Just after the last retro: what it read is not read again.
  else if (lastRetro) [since, source] = [new Date(Date.parse(lastRetro.until) + 1), 'last-retro'];
  else {
    const whole = await projectHistory(dir, { env });
    for (const [label, days] of [
      ['last 7 days', 7],
      ['last 30 days', 30],
    ] as const) {
      const from = now - days * DAY;
      const ts = whole.stores.flatMap((s) => s.threads).filter((t) => Date.parse(t.lastActivityAt) >= from);
      options.push({
        label,
        since: new Date(from).toISOString(),
        flag: `--since ${days}d`,
        threads: ts.length,
        bytes: ts.reduce((n, t) => n + t.bytes, 0),
      });
    }
    options.push({ label: 'whole history', since: null, flag: '--all', threads: whole.threads, bytes: whole.bytes });
    const pick = options.find((o) => o.threads > 0) ?? options[0]!;
    since = pick.since ? new Date(pick.since) : null;
    source = 'proposed';
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
  };
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

/** The input of the analysis step: preferences, previous retros, statistics, and every thread. */
export function analysisInput(ctx: AnalysisContext): string {
  const { retro, threads } = ctx;
  const labels = retro.classification?.labels ?? {};
  const prefs = ctx.preferences.length ? ctx.preferences.map((p) => `- ${p.id}: ${p.body}`) : ['None yet.'];
  return [
    `# Retro input — ${retro.root}`,
    `Retro ${retro.id}. Period: ${retro.since ?? 'the whole history'} to ${retro.until}. ${threads.size} threads, from ${retro.stores.length} comment store(s): ${retro.stores.map((s) => s.root).join(', ')}.`,
    '',
    "## The user's retro preferences (apply them)",
    ...prefs,
    '',
    '## Previous retros',
    ...renderPrevious(ctx.previous, exclusionsOf(ctx.previous)),
    '',
    '## Statistics (computed without a model)',
    ...renderStats(statsOf(ctx)),
    '',
    `## Threads (all ${threads.size} of them, oldest first)`,
    '',
    ...[...threads.values()].map(({ thread, store }) => {
      const sig = threadSignals(thread);
      const extra = [
        label(labels[thread.id]),
        sig.reopened ? 'reopened' : '',
        sig.question ? 'agent asked' : '',
        sig.rounds ? `${sig.rounds} round(s) of back-and-forth` : '',
      ].filter(Boolean);
      return threadText(thread, store) + (extra.length ? `\n(${extra.join(' · ')})` : '') + '\n';
    }),
  ].join('\n');
}

/** Writes a retro's input for its agents, and says where. */
export async function writeRetroFile(book: RetroBook, id: string, name: string, content: string): Promise<string> {
  const file = join(await book.workDir(id), name);
  await writeFile(file, content);
  return file;
}

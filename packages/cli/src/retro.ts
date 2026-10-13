import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  analysisInput,
  arbiterInput,
  AUDIT_FILE,
  checkFindings,
  FINDING_SOURCES,
  SOURCE_TITLE,
  sourceInput,
  type AnalysisContext,
  type FindingSource,
  type GuardContext,
  type SourceFiles,
  readRetroSessions,
  readSessionReport,
  reportRead,
  reportMoments,
  reportsDir,
  reportText,
  type GuardSession,
  type SessionReport,
  type SessionsOverview,
  type RetroSession,
  type SessionEvidence,
  readConfig,
  readSourceSettings,
  writeProjectConfig,
  measureText,
  RETRO_SOURCES,
  SOURCE_KEY,
  SOURCE_SETTINGS,
  type RetroSource,
  type SourceSetting,
  type SourceSettings,
  cadenceSummary,
  changeRef,
  changesToVerify,
  checkProposals,
  dueReasons,
  classifyInput,
  COLUMNS,
  DECISIONS,
  exclusionsOf,
  FEEDBACK_CATEGORIES,
  formatBytes,
  HISTORY_STATES,
  jevKeySetupCommand,
  jevKeyStatus,
  prepareStoreHome,
  RetroBook,
  retroHome,
  retroCadence,
  retroScope,
  retroThreads,
  statsOf,
  storeLabel,
  TARGETS,
  writeRetroFile,
  type Column,
  type Decision,
  type GuardResult,
  type Proposal,
  type RetroScope,
  type RetroState,
  type SessionsMode,
  type Target,
  type UnusedTool,
  TOOL_TITLE,
  type ThreadHistory,
  type ThreadLabel,
  type Verdict,
  type Verification,
} from '@silykat/core';
import { parse, str, UsageError, type Values } from './args';
import type { Io } from './cli';

export const RETRO_USAGE = `Retros (look back at the feedback of a period with your agent, and improve its setup):
  slk retro scope [--since <date> | --all]
                                          What a retro would cover: period (since the last retro),
                                          stores, threads, size, time; its sources and their
                                          settings; the last retro, preferences
  slk retro sources [--set <source>=yes|no|ask]…
                                          The settings of the sources of a retro (reviews, sessions,
                                          audit): those of the project, else of the machine; --set
                                          writes the project's (in its .silykat/config.json)
  slk retro start [--since <date> | --all] [--sources reviews,sessions,audit]
                                          Start a retro on that period, reading those sources (at
                                          least one; default: all three): prints its id
  slk retro feedback <retro> --body -     What the user said about the previous retro
  slk retro input <retro> --for classify|threads|sessions|audit|analysis
                                          Write what a step of the retro reads, in a file of the
                                          retro: prints its path. threads, sessions, audit: one
                                          source, for its own agent; analysis: the findings of every
                                          source (or every source, when none was read on its own)
  slk retro findings <retro> --source threads|sessions|audit --body -
                                          Record what one source shows: {"findings":[{"subject",
                                          "cause","evidence"|"sessions"|"audit","confidence",…}]}
                                          (refused while some are rejected)
  slk retro classification <retro> --by <name> --body -
                                          Record labels: {"labels":[{"thread","category",
                                          "confidence","missingRule","ignoredRule"}]}
  slk retro check <retro> --body -        Apply the guard rails to proposals, record nothing
  slk retro propose <retro> --body -      Record the proposals (refused while some are rejected)
  slk retro show <retro>                  The retro: proposals with their threads and numbers
  slk retro show <retro> <proposal> | --next
                                          One proposal, to present it to the user (--next: the next
                                          one to decide, in the order of the discussion)
  slk retro decide <retro> <proposal> accepted|modified|excluded|retargeted
           [--target project-shared|project-personal|user] [--note <text>]
  slk retro applied <retro> <proposal> --file <path>…
                                          Files changed for a proposal
  slk retro undo <retro> <proposal>       Undo a decision recorded by mistake, with its files
                                          (the journal is never edited by hand)
  slk retro finish <retro>                Close the retro: prints the files changed
  slk retro list                          The retros of the project
  slk retro prefs [add --body <text> | remove <id>]
                                          The user's retro preferences
  slk retro key                           Is the Jev key set up, and safely? (never read)
  slk retro cadence                       Is a retro due? Days, size of the threads and agent
                                          sessions since the last retro, against the reminder
                                          settings (slk config)
  The project is --root (default: the current folder). --body - reads stdin, --body-file a file.`;

const RETRO_OPTIONS = {
  since: { type: 'string' as const },
  all: { type: 'boolean' as const },
  format: { type: 'string' as const },
  body: { type: 'string' as const },
  'body-file': { type: 'string' as const },
  for: { type: 'string' as const },
  by: { type: 'string' as const },
  target: { type: 'string' as const },
  note: { type: 'string' as const },
  file: { type: 'string' as const, multiple: true },
  next: { type: 'boolean' as const },
  source: { type: 'string' as const },
  sources: { type: 'string' as const },
  set: { type: 'string' as const, multiple: true },
};

type ParseSince = (value: string | undefined) => Date | null;

export async function retro(rest: string[], io: Io, parseSince: ParseSince): Promise<number> {
  const [action, ...args] = rest;
  const { values, positionals } = parse(args, RETRO_OPTIONS);
  const root = resolve(io.cwd, str(values.root) ?? '.');
  const json = str(values.format) === 'json';
  const ctx: Ctx = { io, values, positionals, root, json, parseSince };
  switch (action) {
    case 'scope':
      return scope(ctx);
    case 'start':
      return start(ctx);
    case 'sources':
      return sources(ctx);
    case 'feedback':
      return feedback(ctx);
    case 'input':
      return input(ctx);
    case 'classification':
      return classification(ctx);
    case 'findings':
      return findings(ctx);
    case 'check':
      return check(ctx, false);
    case 'propose':
      return check(ctx, true);
    case 'show':
      return show(ctx);
    case 'decide':
      return decide(ctx);
    case 'applied':
      return applied(ctx);
    case 'undo':
      return undo(ctx);
    case 'finish':
      return finish(ctx);
    case 'list':
      return list(ctx);
    case 'prefs':
      return prefs(ctx);
    case 'key':
      return key(ctx);
    case 'cadence':
      return cadence(ctx);
    default:
      throw new UsageError(`unknown retro action: ${action ?? '(none)'}`);
  }
}

interface Ctx {
  io: Io;
  values: Values;
  positionals: string[];
  root: string;
  json: boolean;
  parseSince: ParseSince;
}

const book = async (c: Ctx) => new RetroBook(await retroHome(c.root, c.io.env));

async function retroOf(c: Ctx): Promise<{ book: RetroBook; retro: RetroState }> {
  const id = c.positionals[0];
  if (!id) throw new UsageError('missing <retro-id> (slk retro list)');
  const b = await book(c);
  return { book: b, retro: await b.get(id) };
}

async function body(c: Ctx): Promise<string> {
  let text = str(c.values.body);
  if (text === '-') text = await c.io.readStdin();
  const file = str(c.values['body-file']);
  if (file) text = await readFile(resolve(c.io.cwd, file), 'utf8');
  if (text === undefined || text.trim() === '') throw new UsageError('needs --body <text>, --body - or --body-file');
  return text;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const out = (c: Ctx, data: unknown, md: () => string) => {
  c.io.out(c.json ? JSON.stringify(data, null, 2) : md());
  return 0;
};

async function scopeOf(c: Ctx): Promise<RetroScope> {
  const all = c.values.all === true;
  const since = c.parseSince(str(c.values.since));
  if (all && since) throw new UsageError('--since and --all do not go together');
  return retroScope(c.root, { since, all, env: c.io.env });
}

/** A path as a shell argument. */
const quote = (p: string) => (/^[\w./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`);

const minutes = (s: number) => (s < 90 ? `${Math.max(1, Math.round(s / 60))} min` : `${Math.round(s / 60)} min`);
/** A date and time, in local time. */
export function day(iso: string | null): string {
  if (!iso) return 'the start';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** How a retro reads the agent's sessions, in a line. */
export const SESSIONS_MODE_LINE: Record<SessionsMode, string> = {
  reports:
    "through a report on each session, written by a model (finer, costs more; or the agent's own summaries, cheaper: slk config set retro-sessions insights)",
  insights:
    "through the agent's own summaries of them (Claude Code's /insights: cheaper; or a report on each session, finer: slk config set retro-sessions reports)",
};

/** The sources of a retro, as the user knows them. */
export const SOURCE_NAME: Record<RetroSource, string> = {
  reviews: 'Reviews (your review threads)',
  sessions: 'Sessions (your sessions with the agent)',
  audit: 'Audit of the setup (/doctor prompt-audit)',
};

const SETTING_MEANING: Record<SourceSetting, string> = {
  yes: 'always read',
  no: 'never read',
  ask: 'asked at each retro',
};

const ORIGIN: Record<SourceSettings['sources'][RetroSource]['origin'], string> = {
  project: "the project's setting",
  machine: "the machine's setting",
  default: 'the default',
};

/** The settings of the sources, and what to ask when the project has none yet. */
function renderSources(settings: SourceSettings, s: RetroScope | null, root: string): string[] {
  const lines = [
    '## Sources',
    '',
    'A retro reads one source or more (at least one), as their settings say: yes (always), no (never), ask (asked at each retro).',
    '',
  ];
  for (const src of RETRO_SOURCES) {
    const x = settings.sources[src];
    const data =
      src === 'reviews' && s
        ? ` In this period: ${s.history.threads} thread${s.history.threads === 1 ? '' : 's'}.`
        : src === 'audit' && s
          ? ` About ${minutes(s.estimate.audit)}.`
          : '';
    lines.push(`- **${SOURCE_NAME[src]}**: ${x.setting}, ${SETTING_MEANING[x.setting]} (${ORIGIN[x.origin]}).${data}`);
  }
  lines.push(
    '',
    ...(settings.projectSet
      ? ['The project has its retro settings: follow them, without asking for them again (even at its first retro).']
      : [
          'This project has no retro settings yet: ask the user the setting of each source (yes, no or ask), then save them for the project:',
          `slk retro sources --root ${quote(root)} --set reviews=<yes|no|ask> --set sessions=<yes|no|ask> --set audit=<yes|no|ask>`,
        ]),
  );
  return lines;
}

function renderScope(
  s: RetroScope,
  keepHistory: boolean,
  sessionsMode: SessionsMode,
  settings: SourceSettings,
): string {
  const h = s.history;
  const period =
    s.source === 'last-retro'
      ? `since the last retro (${day(s.since)})`
      : s.source === 'all'
        ? 'the whole history'
        : s.source === 'given'
          ? `since ${day(s.since)}`
          : s.since
            ? `proposed for a first retro: since ${day(s.since)}`
            : 'proposed for a first retro: the whole history';
  const lines = [
    `# Retro scope — ${s.root}`,
    '',
    `- **Period**: ${period}, until now.`,
    `- **Threads**: ${h.threads} (${HISTORY_STATES.map((st) => `${h.states[st]} ${st}`).join(', ')}).`,
    ...(keepHistory
      ? []
      : [
          '- **History**: not kept on this machine (keep-history is off): deleted threads are erased, so this retro does not see them.',
        ]),
    `- **The agent's sessions**: read ${SESSIONS_MODE_LINE[sessionsMode]}.`,
    `- **Size**: ${formatBytes(h.bytes)} of journals, about ${Math.round(s.estimate.tokens / 1000)}k tokens to read.`,
    `- **Time** (estimate): classification ${minutes(s.estimate.classifyJev)} with Jev or ${minutes(s.estimate.classifyModel)} with a small model, then analysis ${minutes(s.estimate.analysis)}.`,
    `- **Retro journal**: ${resolve(s.home, '.silykat', 'retros')}`,
    '',
    ...renderSources(settings, s, s.root),
    '',
    '## Comment stores',
    '',
    ...(h.stores.length
      ? h.stores.map(
          (st) => `- ${storeLabel(st, h.root)} (${st.origin}): ${st.threads.length} threads, ${formatBytes(st.bytes)}`,
        )
      : ['- none: nothing has been commented in this project yet']),
  ];
  if (s.options.length > 0) {
    lines.push('', '## Periods to choose from', '');
    for (const o of s.options)
      lines.push(
        `- ${o.label} (${o.flag || 'the default'}${o.proposed ? ', proposed' : ''}): ${o.threads} threads, ${formatBytes(o.bytes)}` +
          (o.overlapsLastRetro ? ' (reads again threads of the last retro)' : ''),
      );
  }
  lines.push('', '## Last retro', '');
  if (!s.lastRetro) lines.push('None: this would be the first retro of this project.');
  else lines.push(...renderOutcome(s.lastRetro));
  if (s.toVerify.length > 0)
    lines.push(
      '',
      `This retro will check whether the ${s.toVerify.length} change(s) adopted then reduced the feedback on their subject.`,
    );
  if (s.unfinished.length > 0) {
    lines.push('', '## Unfinished retros', '');
    for (const r of s.unfinished)
      lines.push(
        `- ${r.id}, started ${day(r.startedAt)}: ${r.proposals.length} proposals, ${Object.keys(r.decisions).length} decided`,
      );
  }
  lines.push('', '## Retro preferences', '');
  lines.push(...(s.preferences.length ? s.preferences.map((p) => `- ${p.id}: ${p.body}`) : ['None yet.']));
  return lines.join('\n');
}

/** What a retro decided and changed. */
function renderOutcome(r: RetroState): string[] {
  const lines = [`${r.id}, ${day(r.since)} to ${day(r.until)}, finished ${day(r.finishedAt)}.`];
  for (const p of r.proposals) {
    const d = r.decisions[p.id];
    const files = r.applied[p.id];
    lines.push(
      `- ${p.id} [${COLUMN_TITLE[p.column]}] ${p.title}: ${d ? d.decision + (d.target ? ` (${d.target})` : '') : 'no decision'}` +
        (files?.length ? ` → ${files.join(', ')}` : ''),
    );
  }
  if (r.proposals.length === 0) lines.push('- no proposal');
  return lines;
}

async function scope(c: Ctx): Promise<number> {
  const s = await scopeOf(c);
  const { keepHistory, retroSessions: sessionsMode } = await readConfig(c.io.env);
  const settings = await readSourceSettings(s.home, c.io.env);
  return out(
    c,
    {
      ...s,
      keepHistory,
      sessionsMode,
      sources: settings,
      history: undefined,
      threads: s.history.threads,
      bytes: s.history.bytes,
      states: s.history.states,
      stores: s.history.stores.map((st) => ({
        root: st.root,
        origin: st.origin,
        threads: st.threads.length,
        bytes: st.bytes,
      })),
    },
    () => renderScope(s, keepHistory, sessionsMode, settings),
  );
}

/** `slk retro sources`: the settings of the sources; `--set reviews=yes` writes the project's. */
async function sources(c: Ctx): Promise<number> {
  const home = await retroHome(c.root, c.io.env);
  const sets = Array.isArray(c.values.set) ? c.values.set : [];
  if (sets.length > 0) {
    const change: Partial<Record<(typeof SOURCE_KEY)[RetroSource], SourceSetting>> = {};
    for (const x of sets) {
      const [name, value] = x.split('=').map((v) => v.trim());
      if (!RETRO_SOURCES.includes(name as RetroSource))
        throw new UsageError(`--set takes <source>=<setting>, the source one of ${RETRO_SOURCES.join(', ')}: "${x}"`);
      if (!SOURCE_SETTINGS.includes(value as SourceSetting))
        throw new UsageError(`--set ${name} takes ${SOURCE_SETTINGS.join(', ')}, not "${value ?? ''}"`);
      change[SOURCE_KEY[name as RetroSource]] = value as SourceSetting;
    }
    await prepareStoreHome(home);
    await writeProjectConfig(home, change);
  }
  const settings = await readSourceSettings(home, c.io.env);
  return out(c, settings, () =>
    [...(sets.length ? [`Saved for the project (${home}).`, ''] : []), ...renderSources(settings, null, c.root)].join(
      '\n',
    ),
  );
}

/** The sources given with `--sources reviews,sessions,audit` (all three when not given). */
function sourcesOf(c: Ctx): RetroSource[] {
  const given = str(c.values.sources);
  if (given === undefined) return [...RETRO_SOURCES];
  const names = given
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  for (const n of names)
    if (!RETRO_SOURCES.includes(n as RetroSource))
      throw new UsageError(`--sources takes ${RETRO_SOURCES.join(', ')} (comma-separated), not "${n}"`);
  if (names.length === 0)
    throw new UsageError('a retro reads at least one source: nothing to look back at without one');
  return RETRO_SOURCES.filter((x) => names.includes(x));
}

async function start(c: Ctx): Promise<number> {
  const s = await scopeOf(c);
  const chosen = sourcesOf(c);
  const reviews = chosen.includes('reviews');
  if (reviews && s.history.threads === 0)
    throw new Error(
      'no thread in this period: leave the reviews out of the sources (--sources ' +
        (chosen.filter((x) => x !== 'reviews').join(',') || 'sessions,audit') +
        ')',
    );
  await prepareStoreHome(s.home);
  const r = await new RetroBook(s.home).start({
    root: s.root,
    since: s.since,
    until: s.until,
    stores: reviews
      ? s.history.stores
          .filter((st) => st.threads.length > 0)
          .map((st) => ({ root: st.root, origin: st.origin, threads: st.threads.length, bytes: st.bytes }))
      : [],
    threads: reviews ? s.history.stores.flatMap((st) => st.threads.map((t) => t.id)) : [],
    bytes: reviews ? s.history.bytes : 0,
    sessionsMode: (await readConfig(c.io.env)).retroSessions,
    sources: chosen,
  });
  return out(
    c,
    r,
    () =>
      `Retro ${r.id} started: ` +
      (reviews ? `${r.threads.length} threads, ${formatBytes(r.bytes)}` : 'no review thread (reviews left out)') +
      `, ${day(r.since)} to ${day(r.until)}. Sources: ${r.sources.join(', ')}.`,
  );
}

/** Refuses a step on a source the retro does not read. */
function needsSource(r: RetroState, source: RetroSource, what: string): void {
  if (!r.sources.includes(source))
    throw new Error(
      `retro ${r.id} does not read ${SOURCE_NAME[source].toLowerCase()} (its sources: ${r.sources.join(', ')}): no ${what}`,
    );
}

async function feedback(c: Ctx): Promise<number> {
  const { book: b, retro: r } = await retroOf(c);
  await b.record(r.id, [{ type: 'retro.feedback', body: (await body(c)).trim() }]);
  c.io.out(`Feedback recorded in ${r.id}.`);
  return 0;
}

const INPUT_KINDS = ['classify', 'analysis', ...FINDING_SOURCES] as const;
type InputKind = (typeof INPUT_KINDS)[number];

/** Everything the inputs of the analysis are made of. */
async function analysisContext(c: Ctx, b: RetroBook, r: RetroState) {
  const { threads } = await retroThreads(r, c.io.env);
  const previous = (await b.list()).filter((x) => x.id !== r.id && x.startedAt < r.startedAt);
  const sessions = await retroSessions(b, r);
  const reports = await retroReports(b, r);
  return {
    retro: r,
    threads,
    previous,
    preferences: await b.preferences(),
    sessions,
    ...(reports.length ? { reports: { list: reports, dir: reportsDir(b) } } : {}),
  };
}

/** The report of the audit of the setup, when it ran (written by the agent's adapter). */
async function auditReport(b: RetroBook, r: RetroState): Promise<{ file: string; text: string } | null> {
  const file = join(await b.workDir(r.id), AUDIT_FILE);
  try {
    return { file, text: await readFile(file, 'utf8') };
  } catch {
    return null;
  }
}

/** The input of one source's agent. */
async function sourceInputOf(b: RetroBook, r: RetroState, ctx: AnalysisContext, source: FindingSource) {
  const audit = source === 'audit' ? await auditReport(b, r) : null;
  return sourceInput(ctx, source, { audit: audit?.text ?? null, usage: r.usage });
}

async function input(c: Ctx): Promise<number> {
  const { book: b, retro: r } = await retroOf(c);
  const kind = str(c.values.for) as InputKind;
  if (!INPUT_KINDS.includes(kind)) throw new UsageError(`--for must be one of ${INPUT_KINDS.join(', ')}`);
  if (kind === 'classify' || kind === 'threads') needsSource(r, 'reviews', 'reading of the threads');
  if (kind === 'sessions') needsSource(r, 'sessions', 'reading of the sessions');
  if (kind === 'audit') needsSource(r, 'audit', 'reading of the audit');
  const { threads } = await retroThreads(r, c.io.env);
  const missing = r.threads.filter((id) => !threads.has(id));
  let content: string;
  let sessions: RetroSession[] = [];
  let reports: readonly SessionReport[] = [];
  const bySource = Object.keys(r.findings).length > 0;
  if (kind === 'classify') content = classifyInput(r, threads);
  else {
    const ctx = await analysisContext(c, b, r);
    sessions = ctx.sessions;
    reports = ctx.reports?.list ?? [];
    if (kind !== 'analysis') content = await sourceInputOf(b, r, ctx, kind);
    else if (!bySource) content = analysisInput(ctx);
    else {
      // The sources stay in their own files, written again now, for the analysis to go back to.
      const files: SourceFiles = {};
      for (const source of FINDING_SOURCES)
        if (r.findings[source])
          files[source] = await writeRetroFile(b, r.id, `${source}-input.md`, await sourceInputOf(b, r, ctx, source));
      content = arbiterInput(ctx, r.findings, files, r.usage);
    }
  }
  const file = await writeRetroFile(b, r.id, `${kind}-input.md`, content);
  const lines = content.split('\n').length;
  // Where the agent writes its answer: a file, then one plain command (no heredoc, nothing chained).
  const answer = join(
    dirname(file),
    kind === 'classify' ? 'labels.json' : kind === 'analysis' ? 'proposals.json' : `findings-${kind}.json`,
  );
  const root = `--root ${quote(c.root)}`;
  const next =
    kind === 'classify'
      ? `slk retro classification ${r.id} ${root} --by <your name> --body-file ${quote(answer)}`
      : kind === 'analysis'
        ? `slk retro check ${r.id} ${root} --body-file ${quote(answer)}, then slk retro propose with the same arguments`
        : `slk retro findings ${r.id} ${root} --source ${kind} --body-file ${quote(answer)}`;
  const shown =
    kind === 'analysis' && bySource
      ? [`the findings of ${andList(FINDING_SOURCES.filter((x) => r.findings[x]).map((x) => SOURCE_TITLE[x]))}`]
      : [
          ...(kind === 'classify' || kind === 'analysis' || kind === 'threads' ? [`${threads.size} threads`] : []),
          ...(kind === 'analysis' || kind === 'sessions'
            ? [
                ...(sessions.length
                  ? [`${sessions.length} session${sessions.length === 1 ? '' : 's'} of the agent`]
                  : []),
                ...(reports.length
                  ? [`${reports.length} report${reports.length === 1 ? '' : 's'} on its sessions`]
                  : []),
              ]
            : []),
          ...(kind === 'audit' ? ['the audit of the setup and the usage of its tools'] : []),
        ];
  return out(
    c,
    {
      file,
      lines,
      bytes: Buffer.byteLength(content),
      threads: threads.size,
      sessions: sessions.length,
      reports: reports.length,
      missing,
      answer,
      next,
    },
    () =>
      [
        `Written: ${file}`,
        `${andList(shown) || 'nothing to read'}, ${lines} lines, ${formatBytes(Buffer.byteLength(content))}. Read it all (in parts if needed).`,
        ...(missing.length
          ? [`${missing.length} thread(s) of the retro are no longer found: ${missing.join(', ')}`]
          : []),
        `Then write your JSON in ${answer} and run: ${next}`,
      ].join('\n'),
  );
}

/** `slk retro findings`: checks the findings of one source and records them (refused while some are rejected). */
async function findings(c: Ctx): Promise<number> {
  const { book: b, retro: r } = await retroOf(c);
  const source = str(c.values.source) as FindingSource;
  if (!FINDING_SOURCES.includes(source)) throw new UsageError(`--source must be one of ${FINDING_SOURCES.join(', ')}`);
  needsSource(r, source === 'threads' ? 'reviews' : source, 'findings to record from it');
  const result = checkFindings(parseJson(await body(c)), source, await guardContext(c, b, r));
  const rejected = result.rejected.length > 0;
  if (!rejected)
    await b.record(r.id, [
      {
        type: 'retro.findings',
        source,
        findings: result.findings,
        ...(result.verifications ? { verifications: result.verifications } : {}),
        ...(result.overview ? { overview: result.overview } : {}),
      },
    ]);
  if (c.json) {
    c.io.out(JSON.stringify({ recorded: !rejected, ...result }, null, 2));
    return rejected ? 1 : 0;
  }
  const lines = [
    rejected
      ? `${result.rejected.length} finding(s) rejected: fix them, nothing was recorded.`
      : `Recorded: ${result.findings.length} finding(s) from ${SOURCE_TITLE[source]}` +
        (result.verifications ? `, ${result.verifications.length} change(s) of the last retro checked` : '') +
        (result.overview ? `, an overview of ${result.overview.items.length} item(s)` : '') +
        '.',
    ...result.rejected.map((x) => `- REJECTED ${x.index ? `#${x.index} ` : ''}${x.subject}: ${x.reasons.join('; ')}`),
    ...(result.verifications ?? []).map((v) => `- ${verificationLine(v)}`),
    ...result.notes.map((n) => `  note: ${n}`),
  ];
  c.io.out(lines.join('\n'));
  return rejected ? 1 : 0;
}

/**
 * The agent's sessions the retro reads through the agent's own summaries: those its journal lists,
 * from the file of the retro; none when it reads them through their reports (never both).
 */
async function retroSessions(b: RetroBook, r: RetroState): Promise<RetroSession[]> {
  if (!r.sessions || r.sessionsMode === 'reports' || !r.sources.includes('sessions')) return [];
  const listed = new Set(r.sessions.list.map((x) => x.id));
  return (await readRetroSessions(b, r.id)).filter((x) => listed.has(x.id));
}

/** `a`, `a and b`, `a, b and c`. */
const andList = (xs: readonly string[]) =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;

/** The reports on the agent's sessions the retro reads: those its journal lists as written (none in `insights` mode). */
async function retroReports(b: RetroBook, r: RetroState): Promise<SessionReport[]> {
  if (r.sessionsMode === 'insights' || !r.sources.includes('sessions')) return [];
  const ids = (r.reports?.list ?? []).filter(reportRead).map((x) => x.id);
  const found = await Promise.all(ids.map((id) => readSessionReport(b, id)));
  return found.filter((x): x is SessionReport => x !== null);
}

/** The sessions the guard rails know: those read from the agent's records, and those with a report. */
async function guardSessions(b: RetroBook, r: RetroState): Promise<Map<string, GuardSession>> {
  const out = new Map<string, GuardSession>();
  for (const x of await retroSessions(b, r)) out.set(x.id, { start: x.start, summary: x.summary });
  for (const rep of await retroReports(b, r)) {
    const summary = typeof rep.analysis.summary === 'string' ? rep.analysis.summary : '';
    out.set(rep.session, {
      start: out.get(rep.session)?.start ?? rep.start,
      summary: out.get(rep.session)?.summary ?? null,
      report: { text: reportText(rep), moments: reportMoments(rep), summary: firstSentence(summary) },
    });
  }
  return out;
}

const firstSentence = (text: string) => (/^.*?[.!?](?=\s|$)/s.exec(text.trim())?.[0] ?? text.trim()).slice(0, 300);

/** A session in a list: its date and the start of its id, the words cited, and the moments pointed at. */
const sessionLine = (e: SessionEvidence) =>
  `session ${e.session.slice(0, 8)} (${day(e.start)})${e.excerpt ? `: "${e.excerpt}"` : ', facts only'}` +
  (e.moments?.length
    ? ` (moment${e.moments.length === 1 ? '' : 's'} ${e.moments.map((m) => m.slice(0, 8)).join(', ')})`
    : '');

/** What a proposal rests on, in a few words: its threads and sessions, then `audit` when it comes from one. */
function sourceOf(p: Proposal, audit: string): string {
  const f = p.figures;
  const n = p.sessions?.length ?? 0;
  const parts = [
    ...(f.threads > 0 || (n === 0 && !p.audit) ? [`${f.threads} thread${f.threads === 1 ? '' : 's'}`] : []),
    ...(n ? [`${n} session${n === 1 ? '' : 's'} of the agent`] : []),
  ];
  if (parts.length === 0) return audit;
  return parts.join(' and ') + (p.audit ? `, and ${audit}` : '');
}

/** Said of a proposal that rests on the agent's sessions only. */
const SESSIONS_ONLY = "only the agent's sessions: summaries written by a model, not your own words (no review thread)";

const threadOf = (x: unknown): string => {
  const t = (x as { thread?: unknown } | null)?.thread;
  return typeof t === 'string' ? t : '';
};

/** Labels from a classifier: `{"labels": [{thread, category, …}]}`, or an object keyed by thread. */
function labelsOf(
  data: unknown,
  known: ReadonlySet<string>,
): { labels: Record<string, ThreadLabel>; problems: string[] } {
  const raw = (data as { labels?: unknown })?.labels ?? data;
  const entries: [string, unknown][] = Array.isArray(raw)
    ? raw.map((x) => [threadOf(x), x])
    : typeof raw === 'object' && raw !== null
      ? Object.entries(raw)
      : [];
  const labels: Record<string, ThreadLabel> = {};
  const problems: string[] = [];
  const score = (x: unknown) => (typeof x === 'number' && x >= 0 && x <= 1 ? x : undefined);
  for (const [thread, x] of entries) {
    const l = x as Record<string, unknown>;
    const category = Number(l?.category);
    if (!known.has(thread)) problems.push(`${thread || '(no thread)'}: not a thread of this retro`);
    else if (!FEEDBACK_CATEGORIES[category]) problems.push(`${thread}: category must be 1 to 14`);
    else {
      const label: ThreadLabel = { category };
      const conf = score(l.confidence);
      const missing = score(l.missingRule);
      const ignored = score(l.ignoredRule);
      if (conf !== undefined) label.confidence = conf;
      if (missing !== undefined) label.missingRule = missing;
      if (ignored !== undefined) label.ignoredRule = ignored;
      labels[thread] = label;
    }
  }
  return { labels, problems };
}

async function classification(c: Ctx): Promise<number> {
  const { book: b, retro: r } = await retroOf(c);
  const by = str(c.values.by)?.trim();
  if (!by) throw new UsageError('say who classified with --by <name> (e.g. jev, haiku)');
  needsSource(r, 'reviews', 'classification');
  const { labels, problems } = labelsOf(parseJson(await body(c)), new Set(r.threads));
  if (Object.keys(labels).length === 0)
    throw new Error(`no valid label${problems.length ? `: ${problems.join('; ')}` : ''}`);
  const after = await b.record(r.id, [{ type: 'retro.classified', by, labels }]);
  const done = Object.keys(after.classification?.labels ?? {}).length;
  c.io.out(
    [
      `Recorded ${Object.keys(labels).length} labels (${done}/${r.threads.length} threads classified).`,
      ...problems.map((p) => `Skipped ${p}`),
    ].join('\n'),
  );
  return 0;
}

/** What the guard rails need to know about a retro. */
async function guardContext(c: Ctx, b: RetroBook, r: RetroState): Promise<GuardContext> {
  const { threads } = await retroThreads(r, c.io.env);
  const previous = (await b.list()).filter((x) => x.id !== r.id && x.startedAt < r.startedAt);
  return {
    threads: new Map([...threads].map(([id, x]) => [id, x.thread])),
    labels: r.classification?.labels ?? {},
    exclusions: exclusionsOf(previous),
    adopted: changesToVerify(r, previous),
    sessions: await guardSessions(b, r),
    ...(r.usage ? { usage: { ...r.usage, root: r.root, ...(c.io.env.HOME ? { home: c.io.env.HOME } : {}) } } : {}),
  };
}

/**
 * The proposals, with what the sources' agents already did when the analysis leaves it out: the
 * check of the last retro's changes (threads and sessions), and what recurs across the sessions.
 */
function withFindings(input: unknown, r: RetroState): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;
  const x = { ...(input as Record<string, unknown>) };
  const checked = [...(r.findings.threads?.verifications ?? []), ...(r.findings.sessions?.verifications ?? [])];
  if (x.verify === undefined && checked.length) {
    // One item per change: the threads of one source, the sessions of the other.
    const merged = new Map<string, { change: string; threads?: string[]; sessions?: string[]; notes: string[] }>();
    for (const v of checked) {
      const ref = changeRef(v);
      const m = merged.get(ref) ?? { change: ref, notes: [] };
      if (v.measured?.includes('sessions')) m.sessions = v.afterSessions?.ids ?? [];
      else m.threads = v.after.ids;
      if (v.note) m.notes.push(v.note);
      merged.set(ref, m);
    }
    x.verify = [...merged.values()].map(({ notes, ...m }) => ({
      ...m,
      ...(notes.length ? { note: notes.join(' ') } : {}),
    }));
  }
  if (x.overview === undefined && r.findings.sessions?.overview) x.overview = r.findings.sessions.overview;
  return x;
}

async function check(c: Ctx, record: boolean): Promise<number> {
  const { book: b, retro: r } = await retroOf(c);
  const result = checkProposals(withFindings(parseJson(await body(c)), r), await guardContext(c, b, r));
  const rejected = result.rejected.length > 0;
  if (record && !rejected)
    await b.record(r.id, [
      {
        type: 'retro.proposed',
        proposals: result.proposals,
        watch: result.watch,
        dropped: result.dropped,
        ...(result.verifications.length ? { verifications: result.verifications } : {}),
        ...(result.overview ? { overview: result.overview } : {}),
      },
    ]);
  if (c.json) c.io.out(JSON.stringify({ recorded: record && !rejected, ...result }, null, 2));
  else c.io.out(renderGuards(result, record && !rejected, record));
  return rejected ? 1 : 0;
}

function renderGuards(g: GuardResult, recorded: boolean, record: boolean): string {
  const lines = [
    recorded
      ? `Recorded: ${g.proposals.length} proposals, ${g.watch.length} to watch, ${g.dropped.length} left out.`
      : g.rejected.length
        ? `${g.rejected.length} proposal(s) rejected: fix them${record ? ', nothing was recorded' : ''}.`
        : `The guard rails pass: ${g.proposals.length} proposals, ${g.watch.length} to watch, ${g.dropped.length} left out.`,
  ];
  for (const x of g.rejected)
    lines.push(`- REJECTED ${x.index ? `#${x.index} ` : ''}${x.subject}: ${x.reasons.join('; ')}`);
  for (const v of g.verifications) lines.push(`- ${verificationLine(v)}`);
  for (const p of g.proposals)
    lines.push(
      `- ${p.id} [${p.column}] ${p.subject}: ${p.figures.threads} threads` +
        (p.sessions?.length
          ? ` and ${p.sessions.length} session${p.sessions.length === 1 ? '' : 's'}${p.sessionsOnly ? ' (sessions only)' : ''}`
          : '') +
        (p.askTarget ? ', target to ask' : '') +
        (p.convertedFromKeep ? ', turned from keep into improve' : '') +
        (p.reopens ? `, reopens ${p.reopens.retro}/${p.reopens.proposal}` : '') +
        (p.revisits ? `, revises ${changeRef(p.revisits)}` : '') +
        (p.unused ? `, ${TOOL_TITLE[p.unused.kind]} never used: keep it or remove it?` : ''),
    );
  for (const w of g.watch) lines.push(`- ${w.id} [watch] ${w.subject}`);
  if (g.overview) lines.push(`- overview of the sessions: ${g.overview.items.length} item(s)`);
  for (const d of g.dropped) lines.push(`- left out: ${d.subject} (${d.reason})`);
  for (const n of g.notes) lines.push(`  note: ${n}`);
  return lines.join('\n');
}

const VERDICT: Record<Verdict, string> = {
  stopped: 'stopped: kept',
  decreased: 'decreased: kept',
  'not-decreased': 'not decreased: to revise',
  'not-measured': 'not measured: no data in this period from the sources it rested on',
};

/** The check of an adopted change, in one line: its numbers before and after, source by source, and the verdict. */
export function verificationLine(v: Verification): string {
  const ids = [...v.after.ids, ...(v.afterSessions?.ids.map((x) => x.slice(0, 8)) ?? [])];
  const numbers = measureText(v);
  return (
    `${changeRef(v)} ${v.title}: ${numbers ? `${numbers} → ` : ''}${VERDICT[v.verdict]}` +
    (ids.length ? ` (${ids.join(', ')})` : '')
  );
}

export const COLUMN_TITLE: Record<Column, string> = { keep: 'To keep', remove: 'To remove', improve: 'To improve' };
const TARGET_TITLE: Record<Target, string> = {
  'project-shared': 'project, shared (committed, for the team)',
  'project-personal': 'project, personal (yours, not committed)',
  user: 'you, in every project',
};

function where(t: ThreadHistory | undefined): string {
  if (!t) return '';
  const a = t.anchor;
  return a.range ? ` (${a.path}:${a.range.startLine}, ${t.state})` : ` (${a.path}, ${t.state})`;
}

function renderProposal(p: Proposal, r: RetroState, threads: ReadonlyMap<string, { thread: ThreadHistory }>): string {
  const f = p.figures;
  const d = r.decisions[p.id];
  const lines = [
    `### ${p.id} · ${COLUMN_TITLE[p.column]} · ${p.title}`,
    '',
    `- **Source**: ${sourceOf(p, 'the audit of the setup')}` + (p.sessionsOnly ? ` (${SESSIONS_ONLY})` : ''),
    ...p.evidence.map(
      (e) => `  - ${e.thread}${where(threads.get(e.thread)?.thread)}${e.excerpt ? `: "${e.excerpt}"` : ''}`,
    ),
    ...(p.sessions ?? []).map((e) => `  - ${sessionLine(e)}`),
    ...(p.audit ? [`  - ${AUDIT_NAME}, ${p.audit.location}: ${p.audit.finding}`] : []),
    ...(f.threads > 0
      ? [
          `- **Numbers**: ${f.threads} threads${p.sessions?.length ? ` and ${p.sessions.length} session${p.sessions.length === 1 ? '' : 's'}` : ''}, ${f.reopened} reopened, ${f.questions} with a question from the agent, ${f.rounds} round(s) of back-and-forth, from ${day(f.first)} to ${day(f.last)}`,
        ]
      : []),
    `- **File**: ${p.file}` + (p.rule ? `\n- **Rule**: ${p.rule}` : ''),
    `- **Why**: ${p.why}`,
  ];
  if (p.change) lines.push(`- **Change** (${p.kind}): ${p.change}`);
  lines.push(
    p.askTarget
      ? `- **Target**: to ask the user (nothing in the threads tells it; suggested: ${TARGET_TITLE[p.target]}${p.targetWhy ? `, ${p.targetWhy}` : ''})`
      : `- **Target**: ${TARGET_TITLE[p.target]}${p.targetWhy ? `, because ${p.targetWhy}` : ''}`,
    `- **Confidence**: ${Math.round(p.confidence * 100)}% · recommended: ${p.recommendation}`,
  );
  if (p.convertedFromKeep)
    lines.push(
      `- **Guard rail**: proposed as "keep", but you had to enforce the rule in ${p.convertedFromKeep.threads.join(', ')}`,
    );
  if (p.reopens)
    lines.push(
      `- **Excluded before** (${day(p.reopens.at)}), back for new threads: ${p.reopens.newThreads.join(', ')}`,
    );
  if (p.revisits)
    lines.push(
      `- **Revises** ${changeRef(p.revisits)}, adopted at the last retro: the feedback on its subject did not decrease`,
    );
  if (p.unused) lines.push(`- **Never used**: ${unusedText(p.unused)}`);
  if (p.unused?.fix) lines.push(`- **Fix, if kept**: ${p.unused.fix}`);
  if (d) lines.push(`- **Decision**: ${d.decision}${d.target ? ` (${d.target})` : ''}${d.note ? `: ${d.note}` : ''}`);
  const files = r.applied[p.id];
  if (files?.length) lines.push(`- **Changed**: ${files.join(', ')}`);
  return lines.join('\n');
}

/** Why a tool counts as never used, with what that rests on and its limits. */
function unusedText(u: UnusedTool): string {
  const where =
    u.scope === 'project'
      ? `in the ${u.sessions} session${u.sessions === 1 ? '' : 's'} of this project`
      : `in the ${u.sessions} session${u.sessions === 1 ? '' : 's'} of every project (it is in your own setup)`;
  return (
    `the audit flagged the ${TOOL_TITLE[u.kind]} ${u.name}, but nobody used it ${where} that the agent still keeps on this machine` +
    (u.since ? ` (since ${day(u.since).slice(0, 10)})` : '') +
    `. Limits: only this machine (a ${TOOL_TITLE[u.kind]} shared in the repository may serve your team), and the agent deletes the sessions inactive for more than ${u.keptDays} days.`
  );
}

/** The audit of the setup the analysis can draw on. */
const AUDIT_NAME = '/doctor prompt-audit';

/** The order of the discussion: what to improve, then what to remove, then what to keep. */
const DISCUSSION: readonly Column[] = ['improve', 'remove', 'keep'];

/** Each line of a text, as a Markdown quote. */
const blockquote = (text: string) =>
  text
    .split('\n')
    .map((l) => (l.trim() ? `> ${l}` : '>'))
    .join('\n');

/**
 * One proposal, as the agent shows it to the user: always the same parts, in the same order, under
 * a separator, so that it never runs into what came before.
 */
function presentProposal(
  p: Proposal,
  position: number,
  total: number,
  r: RetroState,
  threads: ReadonlyMap<string, { thread: ThreadHistory }>,
): string {
  const f = p.figures;
  const d = r.decisions[p.id];
  const source =
    sourceOf(p, `the audit of your setup (${AUDIT_NAME})`) + (p.sessionsOnly ? `. **Note**: ${SESSIONS_ONLY}` : '');
  const lines = [
    '---',
    '',
    `## Proposal ${position}/${total} (${p.id}) · ${COLUMN_TITLE[p.column]} · ${p.title}`,
    '',
    `**Source**: ${source}`,
    ...p.evidence.map(
      (e) => `- ${e.thread}${where(threads.get(e.thread)?.thread)}${e.excerpt ? `: "${e.excerpt}"` : ''}`,
    ),
    ...(p.sessions ?? []).map((e) => `- ${sessionLine(e)}`),
    ...(p.audit ? [`- ${AUDIT_NAME}, \`${p.audit.location}\`: ${p.audit.finding}`] : []),
    '',
  ];
  if (f.threads > 0)
    lines.push(
      `**Numbers**: ${f.threads} threads, ${f.reopened} reopened, ${f.questions} with a question from the agent, ${f.rounds} round(s) of back-and-forth, from ${day(f.first)} to ${day(f.last)}.`,
      '',
    );
  lines.push(`**File**: \`${p.file}\` (${p.kind})`, '');
  if (p.rule) lines.push('**Existing rule**:', blockquote(p.rule), '');
  lines.push(`**Why**: ${p.why}`, '');
  if (p.change) lines.push('**Proposed change**:', blockquote(p.change), '');
  lines.push(
    p.askTarget
      ? `**Target**: to choose (nothing in the threads tells it). Suggested: ${TARGET_TITLE[p.target]}${p.targetWhy ? `, ${p.targetWhy}` : ''}.`
      : `**Target**: ${TARGET_TITLE[p.target]}${p.targetWhy ? `, because ${p.targetWhy}` : ''}.`,
    '',
    `**Confidence**: ${Math.round(p.confidence * 100)}% · recommended: ${p.recommendation}`,
  );
  if (p.convertedFromKeep)
    lines.push(
      '',
      `**Guard rail**: proposed as "keep", but you had to enforce the rule in ${p.convertedFromKeep.threads.join(', ')}.`,
    );
  if (p.reopens)
    lines.push(
      '',
      `**Excluded before** (${day(p.reopens.at)}), back for new threads: ${p.reopens.newThreads.join(', ')}.`,
    );
  if (p.revisits)
    lines.push(
      '',
      `**Revises** ${changeRef(p.revisits)}, adopted at the last retro: the feedback on its subject did not decrease.`,
    );
  if (p.unused)
    lines.push(
      '',
      `**Never used**: ${unusedText(p.unused)}`,
      '',
      `**The question**: keep this ${TOOL_TITLE[p.unused.kind]}${p.unused.fix ? ' (and fix it)' : ''}, or remove it?`,
      ...(p.unused.fix ? ['', '**The fix, if you keep it**:', blockquote(p.unused.fix)] : []),
    );
  if (d) lines.push('', `**Decision**: ${d.decision}${d.target ? ` (${d.target})` : ''}${d.note ? `: ${d.note}` : ''}`);
  return lines.join('\n');
}

/** `slk retro show <retro> <proposal>` or `--next`: one proposal, in the order of the discussion. */
async function showOne(c: Ctx, r: RetroState): Promise<number> {
  // What revises a change of the last retro comes first, then the columns.
  const order = [
    ...r.proposals.filter((p) => p.revisits),
    ...DISCUSSION.flatMap((col) => r.proposals.filter((p) => p.column === col && !p.revisits)),
  ];
  const wanted = c.positionals[1];
  const p = wanted ? order.find((x) => x.id === wanted) : order.find((x) => !r.decisions[x.id]);
  if (!p) {
    if (wanted) throw new Error(`Proposal not found: ${wanted} (slk retro show ${r.id})`);
    c.io.out(order.length ? `All ${order.length} proposals are decided.` : 'No proposal recorded yet.');
    return 0;
  }
  const position = order.indexOf(p) + 1;
  if (c.json) {
    c.io.out(
      JSON.stringify({ position, total: order.length, proposal: p, decision: r.decisions[p.id] ?? null }, null, 2),
    );
    return 0;
  }
  const { threads } = await retroThreads(r, c.io.env);
  c.io.out(presentProposal(p, position, order.length, r, threads));
  return 0;
}

async function show(c: Ctx): Promise<number> {
  const { retro: r } = await retroOf(c);
  if (c.positionals[1] || c.values.next) return showOne(c, r);
  const { threads } = await retroThreads(r, c.io.env);
  if (c.json) {
    c.io.out(
      JSON.stringify(
        {
          ...r,
          stats: statsOf({ retro: r, threads }),
          classification: r.classification
            ? { by: r.classification.by, threads: Object.keys(r.classification.labels).length }
            : null,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  const lines = [
    `# Retro ${r.id} — ${r.root}`,
    '',
    `${day(r.since)} to ${day(r.until)} · ${r.threads.length} threads · ${formatBytes(r.bytes)}` +
      (!r.sources.includes('reviews')
        ? ''
        : r.classification
          ? ` · classified by ${r.classification.by.join(', ')}`
          : ' · not classified') +
      (r.finishedAt ? ` · finished ${day(r.finishedAt)}` : ''),
    '',
    `Sources: ${RETRO_SOURCES.map((x) => `${SOURCE_NAME[x]}: ${r.sources.includes(x) ? 'read' : 'not read'}`).join(' · ')}.`,
  ];
  if (r.sessions) {
    const fromSessions = r.proposals.filter((p) => p.sessions?.length).length;
    const withSummary = r.sessions.list.filter((x) => x.summary).length;
    lines.push(
      '',
      `The agent's sessions: ${r.sessions.list.length} in this project and period, ${withSummary} with a summary; ` +
        `${fromSessions} proposal${fromSessions === 1 ? '' : 's'} rest${fromSessions === 1 ? 's' : ''} on them.`,
    );
  }
  if (r.reports) lines.push('', reportsLine(r));
  if (r.preferences.length) lines.push('', 'Preferences: ' + r.preferences.map((p) => `${p.id} ${p.body}`).join(' · '));
  if (r.overview) lines.push('', ...renderOverview(r.overview));
  if (r.verifications.length || r.feedback.length) {
    lines.push('', "## The last retro's changes: did they help?", '');
    for (const f of r.feedback) lines.push(`- **What you said about them**: ${f}`);
    for (const v of r.verifications) {
      lines.push(`- ${verificationLine(v)}`);
      if (v.note) lines.push(`  ${v.note}`);
    }
  }
  if (r.proposals.length === 0 && r.watch.length === 0) lines.push('', 'No proposal recorded yet.');
  for (const col of COLUMNS) {
    const ps = r.proposals.filter((p) => p.column === col);
    if (ps.length === 0) continue;
    lines.push('', `## ${COLUMN_TITLE[col]}`, '');
    for (const p of ps) lines.push(renderProposal(p, r, threads), '');
  }
  if (r.watch.length) {
    lines.push('', '## To watch (seen in a single thread or session)', '');
    for (const w of r.watch)
      lines.push(
        `- ${w.id} ${w.subject}: ${w.why} (${[
          ...w.evidence.map((e) => e.thread + (e.excerpt ? `: "${e.excerpt}"` : '')),
          ...(w.sessions ?? []).map(sessionLine),
        ].join('; ')})`,
      );
  }
  const conversations = Object.entries(r.conversations);
  if (conversations.length) {
    lines.push('', "## The agent's conversations read back", '');
    for (const [thread, c] of conversations)
      lines.push(
        `- ${thread}: ${c.available ? 'read back' : 'no longer available on this machine, analysed without it'}`,
      );
  }
  if (r.dropped.length) {
    lines.push('', '## Left out by the guard rails', '');
    for (const d of r.dropped) lines.push(`- ${d.subject}: ${d.reason}`);
  }
  c.io.out(lines.join('\n').trimEnd());
  return 0;
}

/** The reports on the agent's sessions a retro reads, in a line. */
function reportsLine(r: RetroState): string {
  const list = r.reports?.list ?? [];
  const n = (status: string) => list.filter((x) => x.status === status).length;
  const ok = n('analysed') + n('reused');
  const fromReports = r.proposals.filter((p) => p.sessions?.some((s) => s.moments?.length)).length;
  return (
    `Reports on the agent's sessions: ${ok} (${n('analysed')} written for this retro, ${n('reused')} kept from before)` +
    (n('failed') ? `, ${n('failed')} could not be written` : '') +
    (n('excluded') ? `, ${n('excluded')} left out (too long to analyse)` : '') +
    (r.proposals.length
      ? `; ${fromReports} proposal${fromReports === 1 ? '' : 's'} point${fromReports === 1 ? 's' : ''} at moments of them.`
      : '.')
  );
}

const OVERVIEW_TITLE = { pattern: 'Pattern', friction: 'Friction', ritual: 'Ritual' } as const;

/** What recurs across the agent's sessions, for the user to find leads of their own. */
export function renderOverview(o: SessionsOverview): string[] {
  return [
    '## Your sessions with the agent: what recurs',
    '',
    ...(o.summary ? [o.summary, ''] : []),
    ...o.items.map(
      (i) =>
        `- **${OVERVIEW_TITLE[i.kind]}: ${i.title}** (${i.sessions.length} session${i.sessions.length === 1 ? '' : 's'}: ${i.sessions.map((s) => s.slice(0, 8)).join(', ')}). ${i.description}` +
        (i.idea ? ` Lead: ${i.idea}` : ''),
    ),
  ];
}

const DECISION_ALIASES: Record<string, Decision> = {
  accept: 'accepted',
  modify: 'modified',
  exclude: 'excluded',
  retarget: 'retargeted',
};

async function decide(c: Ctx): Promise<number> {
  const { book: b, retro: r } = await retroOf(c);
  const [, proposal, word] = c.positionals;
  const p = r.proposals.find((x) => x.id === proposal);
  if (!p) throw new Error(`Proposal not found: ${proposal ?? '(none)'} (slk retro show ${r.id})`);
  const decision = (DECISION_ALIASES[word ?? ''] ?? word) as Decision;
  if (!DECISIONS.includes(decision)) throw new UsageError(`the decision must be one of ${DECISIONS.join(', ')}`);
  const target = str(c.values.target) as Target | undefined;
  if (target !== undefined && !TARGETS.includes(target))
    throw new UsageError(`--target must be one of ${TARGETS.join(', ')}`);
  if (decision === 'retargeted' && !target) throw new UsageError('retargeted needs --target');
  const note = str(c.values.note)?.trim();
  await b.record(r.id, [
    { type: 'retro.decided', proposal: p.id, decision, ...(target ? { target } : {}), ...(note ? { note } : {}) },
  ]);
  c.io.out(`${p.id} ${decision}${target ? ` (${target})` : ''}.`);
  return 0;
}

async function undo(c: Ctx): Promise<number> {
  const { book: b, retro: r } = await retroOf(c);
  const proposal = c.positionals[1];
  const p = r.proposals.find((x) => x.id === proposal);
  if (!p) throw new Error(`Proposal not found: ${proposal ?? '(none)'} (slk retro show ${r.id})`);
  if (r.finishedAt) throw new Error(`Retro ${r.id} is finished`);
  const d = r.decisions[p.id];
  if (!d) throw new Error(`${p.id} has no decision to undo`);
  const files = r.applied[p.id] ?? [];
  await b.record(r.id, [{ type: 'retro.undone', proposal: p.id }]);
  c.io.out(
    `${p.id}: decision "${d.decision}" undone` +
      (files.length
        ? `, and its files changed forgotten (${files.join(', ')}): undo those changes if they were not for it.`
        : '.'),
  );
  return 0;
}

async function applied(c: Ctx): Promise<number> {
  const { book: b, retro: r } = await retroOf(c);
  const proposal = c.positionals[1];
  const p = r.proposals.find((x) => x.id === proposal);
  if (!p) throw new Error(`Proposal not found: ${proposal ?? '(none)'}`);
  const d = r.decisions[p.id];
  if (!d || d.decision === 'excluded') throw new Error(`${p.id} was not accepted: decide it first (slk retro decide)`);
  const files = (Array.isArray(c.values.file) ? c.values.file : []).map((f) => resolve(c.io.cwd, f));
  if (files.length === 0) throw new UsageError('say which files changed with --file <path>');
  await b.record(r.id, [{ type: 'retro.applied', proposal: p.id, files }]);
  c.io.out(`${p.id}: ${files.length} file(s) recorded.`);
  return 0;
}

async function finish(c: Ctx): Promise<number> {
  const { book: b, retro: r } = await retroOf(c);
  const done = await b.record(r.id, [{ type: 'retro.finished' }]);
  const files = [...new Set(Object.values(done.applied).flat())].sort();
  const count = (d: Decision) => Object.values(done.decisions).filter((x) => x.decision === d).length;
  const undecided = done.proposals.filter((p) => !done.decisions[p.id]).map((p) => p.id);
  return out(c, { id: done.id, files, decisions: done.decisions, undecided, watch: done.watch }, () =>
    [
      `Retro ${done.id} finished: ${count('accepted')} accepted, ${count('modified')} modified, ${count('retargeted')} with another target, ${count('excluded')} excluded` +
        (undecided.length ? `, ${undecided.length} without a decision (${undecided.join(', ')})` : '') +
        '.',
      '',
      files.length ? `Files changed (${files.length}):` : 'No file changed.',
      ...files.map((f) => `- ${f}`),
      ...(done.watch.length ? ['', 'To watch:', ...done.watch.map((w) => `- ${w.subject}`)] : []),
      ...sessionsCost(done),
      ...reportsCost(done),
    ].join('\n'),
  );
}

/** What reading the agent's sessions took, at the end of the retro. */
function sessionsCost(r: RetroState): string[] {
  const s = r.sessions;
  if (!s || (s.costUsd === null && s.durationMs === null)) return [];
  const time = s.durationMs === null ? '' : ` took ${Math.max(1, Math.round(s.durationMs / 60_000))} min`;
  const cost =
    s.costUsd === null
      ? ''
      : ` and about $${s.costUsd.toFixed(2)} at the API list price (on a subscription, tokens counted against your usage limits, not a bill)`;
  return ['', `Reading the agent's sessions (${s.source})${time}${cost}.`];
}

/** What writing the reports on the agent's sessions took, at the end of the retro. */
function reportsCost(r: RetroState): string[] {
  const s = r.reports;
  if (!s) return [];
  const written = s.list.filter((x) => x.status === 'analysed').length;
  const reused = s.list.filter((x) => x.status === 'reused').length;
  const time = s.durationMs === null ? '' : `, in ${Math.max(1, Math.round(s.durationMs / 60_000))} min`;
  const tokens = s.tokens === null ? '' : `, ${formatTokens(s.tokens)} tokens`;
  const cost =
    s.costUsd === null
      ? ''
      : `, about $${s.costUsd.toFixed(2)} at the API list price (on a subscription, tokens counted against your usage limits, not a bill)`;
  return [
    '',
    `Reports on the agent's sessions: ${written} written${reused ? ` (${reused} kept from earlier retros, at no cost)` : ''}${written ? `${time}${tokens}${cost}` : ''}.`,
  ];
}

const formatTokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} M` : n >= 1000 ? `${Math.round(n / 1000)} k` : String(n);

async function list(c: Ctx): Promise<number> {
  const all = await (await book(c)).list();
  return out(
    c,
    all.map((r) => ({
      id: r.id,
      root: r.root,
      since: r.since,
      until: r.until,
      threads: r.threads.length,
      proposals: r.proposals.length,
      finishedAt: r.finishedAt,
    })),
    () =>
      all.length === 0
        ? 'No retro yet in this project.'
        : all
            .map(
              (r) =>
                `${r.id} · ${r.root} · ${day(r.since)} to ${day(r.until)} · ${r.threads.length} threads · ${r.proposals.length} proposals · ${r.finishedAt ? 'finished' : 'unfinished'}`,
            )
            .join('\n'),
  );
}

async function prefs(c: Ctx): Promise<number> {
  const b = await book(c);
  const [verb, id] = c.positionals;
  if (verb === 'add') {
    await prepareStoreHome(b.home);
    const p = await b.addPreference(await body(c));
    c.io.out(`Preference ${p.id} saved: ${p.body}`);
    return 0;
  }
  if (verb === 'remove') {
    if (!id) throw new UsageError('missing <preference-id>');
    await b.removePreference(id);
    c.io.out(`Preference ${id} removed.`);
    return 0;
  }
  if (verb !== undefined) throw new UsageError(`unknown prefs action: ${verb}`);
  const all = await b.preferences();
  return out(c, all, () => (all.length ? all.map((p) => `${p.id}: ${p.body}`).join('\n') : 'No retro preference yet.'));
}

async function key(c: Ctx): Promise<number> {
  const s = await jevKeyStatus(c.io.env);
  const setup = jevKeySetupCommand();
  return out(c, { ...s, setupCommand: setup }, () => {
    if (s.source === 'env') return 'Jev: the key comes from $JEV_API_KEY. Ready.';
    if (!s.exists)
      return [
        `Jev: no key (expected in ${s.path}). The classification will use a small model instead.`,
        'To add one, the user runs this in their own terminal, not through the agent (it asks for the key without showing it):',
        '',
        `  ${setup}`,
      ].join('\n');
    return s.ok
      ? `Jev: key file ${s.path} (mode ${s.mode}, only you can read it, in no repository). Ready.`
      : [
          `Jev: key file ${s.path} is not safe yet${s.private ? '' : ` (mode ${s.mode}: others can read it)`}${s.inRepo ? ` (inside the repository ${s.inRepo})` : ''}.`,
          'Fix:',
          ...s.fixes.map((f) => `  ${f}`),
        ].join('\n');
  });
}

async function cadence(c: Ctx): Promise<number> {
  const cad = await retroCadence(c.root, { env: c.io.env });
  if (!cad) throw new UsageError('a retro is about a project folder, not the root of the file system');
  return out(c, cad, () => {
    const t = cad.thresholds;
    return [
      cad.due ? `A retro is due: ${cadenceSummary(cad)}.` : `No retro due yet: ${cadenceSummary(cad)}.`,
      ...dueReasons(cad).map((r) => `- ${r}`),
      `Reminder settings (slk config): ${t.days} days, or ${formatBytes(t.bytes)} of threads, and never more than ${t.maxDays} days.`,
    ].join('\n');
  });
}

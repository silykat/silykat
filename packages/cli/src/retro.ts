import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  analysisInput,
  checkProposals,
  classifyInput,
  COLUMNS,
  DECISIONS,
  exclusionsOf,
  FEEDBACK_CATEGORIES,
  HISTORY_STATES,
  jevKeySetupCommand,
  jevKeyStatus,
  prepareStoreHome,
  RetroBook,
  retroHome,
  retroScope,
  retroThreads,
  statsOf,
  TARGETS,
  writeRetroFile,
  type Column,
  type Decision,
  type GuardResult,
  type Proposal,
  type RetroScope,
  type RetroState,
  type Target,
  type ThreadHistory,
  type ThreadLabel,
} from '@local-review/core';
import { parse, str, UsageError, type Values } from './args';
import type { Io } from './cli';
import { formatBytes, storeLabel } from './history';

export const RETRO_USAGE = `Retros (look back at the feedback of a period with your agent, and improve its setup):
  lr retro scope [--since <date> | --all]  What a retro would cover: period (since the last retro),
                                          stores, threads, size, time; the last retro, preferences
  lr retro start [--since <date> | --all]  Start a retro on that period: prints its id
  lr retro feedback <retro> --body -       What the user said about the previous retro
  lr retro input <retro> --for classify|analysis
                                          Write what the classification or analysis step reads, in
                                          a file of the retro: prints its path
  lr retro classification <retro> --by <name> --body -
                                          Record labels: {"labels":[{"thread","category",
                                          "confidence","missingRule","ignoredRule"}]}
  lr retro check <retro> --body -          Apply the guard rails to proposals, record nothing
  lr retro propose <retro> --body -        Record the proposals (refused while some are rejected)
  lr retro show <retro>                    The retro: proposals with their threads and numbers
  lr retro show <retro> <proposal> | --next
                                          One proposal, to present it to the user (--next: the next
                                          one to decide, in the order of the discussion)
  lr retro decide <retro> <proposal> accepted|modified|excluded|retargeted
           [--target project-shared|project-personal|user] [--note <text>]
  lr retro applied <retro> <proposal> --file <path>…   Files changed for a proposal
  lr retro undo <retro> <proposal>         Undo a decision recorded by mistake, with its files
                                          (the journal is never edited by hand)
  lr retro finish <retro>                  Close the retro: prints the files changed
  lr retro list                            The retros of the project
  lr retro prefs [add --body <text> | remove <id>]     The user's retro preferences
  lr retro key                             Is the Jev key set up, and safely? (never read)
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
    case 'feedback':
      return feedback(ctx);
    case 'input':
      return input(ctx);
    case 'classification':
      return classification(ctx);
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
  if (!id) throw new UsageError('missing <retro-id> (lr retro list)');
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

function renderScope(s: RetroScope): string {
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
    `- **Size**: ${formatBytes(h.bytes)} of journals, about ${Math.round(s.estimate.tokens / 1000)}k tokens to read.`,
    `- **Time** (estimate): classification ${minutes(s.estimate.classifyJev)} with Jev or ${minutes(s.estimate.classifyModel)} with a small model, then analysis ${minutes(s.estimate.analysis)}.`,
    `- **Retro journal**: ${resolve(s.home, '.local-review', 'retros')}`,
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
    lines.push('', '## Periods for a first retro', '');
    for (const o of s.options) lines.push(`- ${o.label} (${o.flag}): ${o.threads} threads, ${formatBytes(o.bytes)}`);
  }
  lines.push('', '## Last retro', '');
  if (!s.lastRetro) lines.push('None: this would be the first retro of this project.');
  else lines.push(...renderOutcome(s.lastRetro));
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
  return out(
    c,
    {
      ...s,
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
    () => renderScope(s),
  );
}

async function start(c: Ctx): Promise<number> {
  const s = await scopeOf(c);
  if (s.history.threads === 0) throw new Error('no thread in this period: nothing to look back at');
  await prepareStoreHome(s.home);
  const r = await new RetroBook(s.home).start({
    root: s.root,
    since: s.since,
    until: s.until,
    stores: s.history.stores
      .filter((st) => st.threads.length > 0)
      .map((st) => ({ root: st.root, origin: st.origin, threads: st.threads.length, bytes: st.bytes })),
    threads: s.history.stores.flatMap((st) => st.threads.map((t) => t.id)),
    bytes: s.history.bytes,
  });
  return out(
    c,
    r,
    () =>
      `Retro ${r.id} started: ${r.threads.length} threads, ${formatBytes(r.bytes)}, ${day(r.since)} to ${day(r.until)}.`,
  );
}

async function feedback(c: Ctx): Promise<number> {
  const { book: b, retro: r } = await retroOf(c);
  await b.record(r.id, [{ type: 'retro.feedback', body: (await body(c)).trim() }]);
  c.io.out(`Feedback recorded in ${r.id}.`);
  return 0;
}

async function input(c: Ctx): Promise<number> {
  const { book: b, retro: r } = await retroOf(c);
  const kind = str(c.values.for);
  if (kind !== 'classify' && kind !== 'analysis') throw new UsageError('--for must be "classify" or "analysis"');
  const { threads } = await retroThreads(r, c.io.env);
  const missing = r.threads.filter((id) => !threads.has(id));
  let content: string;
  if (kind === 'classify') content = classifyInput(r, threads);
  else {
    const previous = (await b.list()).filter((x) => x.id !== r.id && x.startedAt < r.startedAt);
    content = analysisInput({ retro: r, threads, previous, preferences: await b.preferences() });
  }
  const file = await writeRetroFile(b, r.id, `${kind}-input.md`, content);
  const lines = content.split('\n').length;
  // Where the agent writes its answer: a file, then one plain command (no heredoc, nothing chained).
  const answer = join(dirname(file), kind === 'classify' ? 'labels.json' : 'proposals.json');
  const root = `--root ${quote(c.root)}`;
  const next =
    kind === 'classify'
      ? `lr retro classification ${r.id} ${root} --by <your name> --body-file ${quote(answer)}`
      : `lr retro check ${r.id} ${root} --body-file ${quote(answer)}, then lr retro propose with the same arguments`;
  return out(c, { file, lines, bytes: Buffer.byteLength(content), threads: threads.size, missing, answer, next }, () =>
    [
      `Written: ${file}`,
      `${threads.size} threads, ${lines} lines, ${formatBytes(Buffer.byteLength(content))}. Read it all (in parts if needed).`,
      ...(missing.length
        ? [`${missing.length} thread(s) of the retro are no longer found: ${missing.join(', ')}`]
        : []),
      `Then write your JSON in ${answer} and run: ${next}`,
    ].join('\n'),
  );
}

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

async function check(c: Ctx, record: boolean): Promise<number> {
  const { book: b, retro: r } = await retroOf(c);
  const { threads } = await retroThreads(r, c.io.env);
  const previous = (await b.list()).filter((x) => x.id !== r.id && x.startedAt < r.startedAt);
  const result = checkProposals(parseJson(await body(c)), {
    threads: new Map([...threads].map(([id, x]) => [id, x.thread])),
    labels: r.classification?.labels ?? {},
    exclusions: exclusionsOf(previous),
  });
  const rejected = result.rejected.length > 0;
  if (record && !rejected)
    await b.record(r.id, [
      { type: 'retro.proposed', proposals: result.proposals, watch: result.watch, dropped: result.dropped },
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
  for (const x of g.rejected) lines.push(`- REJECTED #${x.index} ${x.subject}: ${x.reasons.join('; ')}`);
  for (const p of g.proposals)
    lines.push(
      `- ${p.id} [${p.column}] ${p.subject}: ${p.figures.threads} threads` +
        (p.askTarget ? ', target to ask' : '') +
        (p.convertedFromKeep ? ', turned from keep into improve' : '') +
        (p.reopens ? `, reopens ${p.reopens.retro}/${p.reopens.proposal}` : ''),
    );
  for (const w of g.watch) lines.push(`- ${w.id} [watch] ${w.subject}`);
  for (const d of g.dropped) lines.push(`- left out: ${d.subject} (${d.reason})`);
  for (const n of g.notes) lines.push(`  note: ${n}`);
  return lines.join('\n');
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
    `- **Source**: ${f.threads} threads` + (p.audit ? `, and the audit of the setup` : ''),
    ...p.evidence.map(
      (e) => `  - ${e.thread}${where(threads.get(e.thread)?.thread)}${e.excerpt ? `: "${e.excerpt}"` : ''}`,
    ),
    ...(p.audit ? [`  - ${AUDIT_NAME}, ${p.audit.location}: ${p.audit.finding}`] : []),
    `- **Numbers**: ${f.threads} threads, ${f.reopened} reopened, ${f.questions} with a question from the agent, ${f.rounds} round(s) of back-and-forth, from ${day(f.first)} to ${day(f.last)}`,
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
  if (d) lines.push(`- **Decision**: ${d.decision}${d.target ? ` (${d.target})` : ''}${d.note ? `: ${d.note}` : ''}`);
  const files = r.applied[p.id];
  if (files?.length) lines.push(`- **Changed**: ${files.join(', ')}`);
  return lines.join('\n');
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
    `${f.threads} thread${f.threads === 1 ? '' : 's'}` +
    (p.audit ? `, and the audit of your setup (${AUDIT_NAME})` : '');
  const lines = [
    '---',
    '',
    `## Proposal ${position}/${total} (${p.id}) · ${COLUMN_TITLE[p.column]} · ${p.title}`,
    '',
    `**Source**: ${source}`,
    ...p.evidence.map(
      (e) => `- ${e.thread}${where(threads.get(e.thread)?.thread)}${e.excerpt ? `: "${e.excerpt}"` : ''}`,
    ),
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
  if (d) lines.push('', `**Decision**: ${d.decision}${d.target ? ` (${d.target})` : ''}${d.note ? `: ${d.note}` : ''}`);
  return lines.join('\n');
}

/** `lr retro show <retro> <proposal>` or `--next`: one proposal, in the order of the discussion. */
async function showOne(c: Ctx, r: RetroState): Promise<number> {
  const order = DISCUSSION.flatMap((col) => r.proposals.filter((p) => p.column === col));
  const wanted = c.positionals[1];
  const p = wanted ? order.find((x) => x.id === wanted) : order.find((x) => !r.decisions[x.id]);
  if (!p) {
    if (wanted) throw new Error(`Proposal not found: ${wanted} (lr retro show ${r.id})`);
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
      (r.classification ? ` · classified by ${r.classification.by.join(', ')}` : ' · not classified') +
      (r.finishedAt ? ` · finished ${day(r.finishedAt)}` : ''),
  ];
  if (r.preferences.length) lines.push('', 'Preferences: ' + r.preferences.map((p) => `${p.id} ${p.body}`).join(' · '));
  if (r.proposals.length === 0 && r.watch.length === 0) lines.push('', 'No proposal recorded yet.');
  for (const col of COLUMNS) {
    const ps = r.proposals.filter((p) => p.column === col);
    if (ps.length === 0) continue;
    lines.push('', `## ${COLUMN_TITLE[col]}`, '');
    for (const p of ps) lines.push(renderProposal(p, r, threads), '');
  }
  if (r.watch.length) {
    lines.push('', '## To watch (seen in a single thread)', '');
    for (const w of r.watch)
      lines.push(
        `- ${w.id} ${w.subject}: ${w.why} (${w.evidence.map((e) => e.thread + (e.excerpt ? `: "${e.excerpt}"` : '')).join('; ')})`,
      );
  }
  if (r.dropped.length) {
    lines.push('', '## Left out by the guard rails', '');
    for (const d of r.dropped) lines.push(`- ${d.subject}: ${d.reason}`);
  }
  c.io.out(lines.join('\n').trimEnd());
  return 0;
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
  if (!p) throw new Error(`Proposal not found: ${proposal ?? '(none)'} (lr retro show ${r.id})`);
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
  if (!p) throw new Error(`Proposal not found: ${proposal ?? '(none)'} (lr retro show ${r.id})`);
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
  if (!d || d.decision === 'excluded') throw new Error(`${p.id} was not accepted: decide it first (lr retro decide)`);
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
    ].join('\n'),
  );
}

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

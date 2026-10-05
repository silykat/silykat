import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  citedMoments,
  localReviewHome,
  processAncestors,
  readSessionReport,
  RetroBook,
  SESSION_REPORT_VERSION,
  SessionRegistry,
  sessionOfProcess,
  sessionReportIds,
  writeSessionReport,
  type SessionReport,
  type SessionReportRef,
} from '@local-review/core';
import { runProcess, type Runner } from './retroAudit';
import type { ProjectTranscript } from './retroInsights';
import { analyseSession, mask, type SessionAnalytics } from './sessionAnalytics';
import { reportPrompt } from './sessionReportBrief';
import { renderSession } from './sessionTranscript';

/**
 * The reports on Claude Code's sessions of a project, written for a retro: for each session, its
 * analytics (without a model), then a report written by a model (Opus) that judges the signals by
 * reading the conversation around the moments they point at. Each model runs in a separate,
 * non-interactive Claude Code: in safe mode (none of the user's rules, skills, plugins or hooks), with
 * no tool but Read and Grep, in a temporary folder that holds the session's analytics and readable
 * conversations (secrets masked), and without keeping a session of its own. Several run at once.
 *
 * A report is kept (`retros/sessions/` of the project) and not written again, unless the session went
 * on since. Every moment it cites is checked against the session's records: one that does not exist
 * is removed.
 */
export const REPORTS_SOURCE = 'Claude Code session records';
export const REPORT_MODEL = 'opus';
export const REPORT_TIMEOUT_MS = 20 * 60_000;
/** Reports written at once. */
export const REPORT_CONCURRENCY = 4;
/**
 * What one report takes, before this project has any to learn from: a base, and more for each
 * prompt the user typed (measured with Opus on two real sessions: 9 prompts, $0.42 and 1.6 min; 56 prompts
 * and 13 sub-agents, $2.32 and 6.6 min; cost at the API list price).
 */
export const REPORT_COST = { baseUsd: 0.05, perPromptUsd: 0.04, baseMs: 40_000, perPromptMs: 6_500 } as const;

type Env = Record<string, string | undefined>;

/** A session of the period, and what to do with it. */
export interface ReportCandidate {
  transcript: ProjectTranscript;
  analytics: SessionAnalytics;
  /** `write`: no report yet, or the session went on since; `keep`: its report is up to date. */
  action: 'write' | 'keep';
}

export interface ReportPlan {
  candidates: ReportCandidate[];
  /** Sessions left out: no prompt typed by the user, or the session of this retro. */
  noPrompt: number;
  current: number;
}

/** The session this command runs in, when Local Review knows it (the retro's own session). */
export async function currentSession(env: Env): Promise<string | undefined> {
  const sessions = await new SessionRegistry(localReviewHome(env)).list().catch(() => []);
  return sessionOfProcess(sessions, await processAncestors())?.id;
}

/**
 * Which sessions of the period get a report: those with at least one prompt typed by the user, but
 * the retro's own session (`exclude`, or any that mentions `retroId`); a report is kept when it covers
 * the whole session.
 */
export async function planReports(
  book: RetroBook,
  transcripts: readonly ProjectTranscript[],
  opts: { exclude?: ReadonlySet<string>; retroId?: string } = {},
): Promise<ReportPlan> {
  const plan: ReportPlan = { candidates: [], noPrompt: 0, current: 0 };
  for (const t of transcripts) {
    if (opts.exclude?.has(t.id) || (opts.retroId && (await mentions(t.file, opts.retroId)))) {
      plan.current++;
      continue;
    }
    // A session Claude Code deleted meanwhile (cleanupPeriodDays) is no longer there to analyse.
    const analytics = await analyseSession(t.file).catch(() => null);
    if (!analytics) continue;
    if (analytics.counts.typed_prompts === 0) {
      plan.noPrompt++;
      continue;
    }
    const existing = await readSessionReport(book, t.id);
    const upToDate =
      existing !== null && (existing.v > SESSION_REPORT_VERSION || existing.covered.lines >= analytics.counts.lines);
    plan.candidates.push({ transcript: t, analytics, action: upToDate ? 'keep' : 'write' });
  }
  return plan;
}

const mentions = async (file: string, text: string) => (await readFile(file, 'utf8').catch(() => '')).includes(text);

/** What a report on a session with `prompts` typed prompts takes, by the defaults. */
const expected = (prompts: number) => ({
  costUsd: REPORT_COST.baseUsd + REPORT_COST.perPromptUsd * prompts,
  ms: REPORT_COST.baseMs + REPORT_COST.perPromptMs * prompts,
});

/**
 * How far the reports already written in this project were from the defaults (1 without any): the
 * estimate of the next ones is scaled by it.
 */
export async function reportScale(book: RetroBook): Promise<{ cost: number; time: number }> {
  let actualCost = 0;
  let expectedCost = 0;
  let actualMs = 0;
  let expectedMs = 0;
  for (const id of await sessionReportIds(book)) {
    const r = await readSessionReport(book, id);
    if (!r) continue;
    const counts = r.analytics.counts as { typed_prompts?: unknown } | undefined;
    const e = expected(typeof counts?.typed_prompts === 'number' ? counts.typed_prompts : 0);
    if (r.run.costUsd != null) {
      actualCost += r.run.costUsd;
      expectedCost += e.costUsd;
    }
    if (r.run.durationMs != null) {
      actualMs += r.run.durationMs;
      expectedMs += e.ms;
    }
  }
  return { cost: expectedCost ? actualCost / expectedCost : 1, time: expectedMs ? actualMs / expectedMs : 1 };
}

/**
 * An estimate of what writing the reports takes, from the sessions' sizes (prompts typed): the cost,
 * and the time with `REPORT_CONCURRENCY` written at once.
 */
export async function estimateReports(
  book: RetroBook,
  prompts: readonly number[],
): Promise<{ costUsd: number; ms: number }> {
  const scale = await reportScale(book);
  const workers: number[] = Array.from({ length: REPORT_CONCURRENCY }, () => 0);
  let costUsd = 0;
  for (const p of prompts) {
    const e = expected(p);
    costUsd += e.costUsd * scale.cost;
    const free = workers.indexOf(Math.min(...workers));
    workers[free]! += e.ms * scale.time;
  }
  return { costUsd, ms: Math.max(0, ...workers) };
}

/** The arguments of a report's Claude Code. */
export function reportArgs(prompt: string): string[] {
  return [
    '-p',
    prompt,
    '--model',
    REPORT_MODEL,
    '--safe-mode',
    '--tools',
    'Read,Grep',
    '--no-session-persistence',
    '--permission-mode',
    'default',
    '--output-format',
    'json',
  ];
}

type Json = Record<string, unknown>;
const isRecord = (x: unknown): x is Json => typeof x === 'object' && x !== null && !Array.isArray(x);

/** The JSON object of a model's answer: the whole answer, or the object in it (code fences aside). */
export function jsonOfAnswer(text: string): Json | null {
  const candidates = [text.trim(), /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1] ?? ''];
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const v: unknown = JSON.parse(c);
      if (isRecord(v)) return v;
    } catch {
      // next candidate
    }
  }
  return null;
}

/** Every string of a value, masked (a model may quote a secret). */
function maskAll<T>(x: T): T {
  if (typeof x === 'string') return mask(x) as T;
  if (Array.isArray(x)) return x.map(maskAll) as T;
  if (isRecord(x)) return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, maskAll(v)])) as T;
  return x;
}

/** Removes the moments that are not in the session's records: cited signals, and `evidence` items. */
export function dropUnknownMoments(node: unknown, known: ReadonlySet<string>): unknown {
  if (Array.isArray(node))
    return node
      .filter((x) => !(isRecord(x) && typeof x.uuid === 'string' && !known.has(x.uuid)))
      .map((x) => dropUnknownMoments(x, known));
  if (isRecord(node))
    return Object.fromEntries(
      Object.entries(node).map(([k, v]) => [
        k,
        k === 'evidence' && Array.isArray(v)
          ? v.filter((x) => typeof x !== 'string' || known.has(x))
          : dropUnknownMoments(v, known),
      ]),
    );
  return node;
}

export type ReportOutcome =
  | { kind: 'done'; report: SessionReport }
  | { kind: 'failed'; reason: string; costUsd: number | null; durationMs: number | null; tokens: number | null };

const tokensOf = (usage: unknown): number | null => {
  if (!isRecord(usage)) return null;
  const n = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']
    .map((k) => usage[k])
    .filter((v): v is number => typeof v === 'number')
    .reduce((s, v) => s + v, 0);
  return n || null;
};

/** Writes the report on one session: its readable conversations in a temporary folder, then the model. */
export async function writeReport(
  c: ReportCandidate,
  env: Env,
  run: Runner = runProcess,
  timeoutMs = REPORT_TIMEOUT_MS,
): Promise<ReportOutcome> {
  const work = await mkdtemp(join(tmpdir(), 'lr-session-report-'));
  try {
    const { transcripts, uuids } = await renderSession(c.transcript.file);
    await writeFile(join(work, 'analytics.json'), JSON.stringify(c.analytics, null, 1));
    for (const t of transcripts) await writeFile(join(work, t.name), t.text);
    const claude = env.LR_CLAUDE_BIN?.trim() || 'claude';
    const r = await run(claude, reportArgs(reportPrompt(c.transcript.id, transcripts.length)), {
      cwd: work,
      env,
      timeoutMs,
    });
    if (r.timedOut)
      return fail(`it took more than ${Math.round(timeoutMs / 60_000)} min`, { costUsd: null, ms: null, tokens: null });
    let out: Json;
    try {
      out = JSON.parse(r.stdout) as Json;
    } catch {
      const why = (r.stderr || r.stdout).trim().split('\n').at(-1) ?? '';
      return fail(`Claude Code ended with code ${r.code ?? '?'}${why ? `: ${why}` : ''}`, {
        costUsd: null,
        ms: null,
        tokens: null,
      });
    }
    const spent = {
      costUsd: typeof out.total_cost_usd === 'number' ? out.total_cost_usd : null,
      ms: typeof out.duration_ms === 'number' ? out.duration_ms : null,
      tokens: tokensOf(out.usage),
    };
    const answer = typeof out.result === 'string' ? out.result : '';
    if (out.is_error === true) return fail(answer.split('\n')[0] || 'an error', spent);
    const raw = jsonOfAnswer(answer);
    if (!raw || typeof raw.summary !== 'string' || !isRecord(raw.signals))
      return fail('the model did not answer with a report', spent);
    const cited = citedMoments(raw);
    const unknown = [...cited].filter((u) => !uuids.has(u)).sort();
    const analysis = maskAll(dropUnknownMoments({ ...raw, session_id: c.transcript.id }, uuids)) as Json;
    const a = c.analytics;
    return {
      kind: 'done',
      report: {
        v: SESSION_REPORT_VERSION,
        session: c.transcript.id,
        agent: 'Claude Code',
        folder: a.cwd ?? c.transcript.cwd,
        start: a.start ?? c.transcript.start,
        end: a.end ?? c.transcript.start,
        covered: { lines: a.counts.lines },
        generatedAt: new Date().toISOString(),
        model: REPORT_MODEL,
        run: { costUsd: spent.costUsd, durationMs: spent.ms, tokens: spent.tokens },
        checks: { citedMoments: cited.size, unknownMoments: unknown },
        analysis,
        analytics: a as unknown as Json,
      },
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

const fail = (
  reason: string,
  spent: { costUsd: number | null; ms: number | null; tokens: number | null },
): ReportOutcome => ({ kind: 'failed', reason, costUsd: spent.costUsd, durationMs: spent.ms, tokens: spent.tokens });

export interface ReportsRun {
  refs: SessionReportRef[];
  costUsd: number | null;
  durationMs: number;
  tokens: number | null;
}

/** Writes the reports a plan needs, several at once, and keeps them; the others are reused. */
export async function writeReports(
  book: RetroBook,
  plan: ReportPlan,
  env: Env,
  run: Runner = runProcess,
  concurrency = REPORT_CONCURRENCY,
): Promise<ReportsRun> {
  const started = Date.now();
  const refs = new Map<string, SessionReportRef>();
  let costUsd: number | null = null;
  let tokens: number | null = null;
  const queue = plan.candidates.filter((c) => c.action === 'write');
  for (const c of plan.candidates)
    if (c.action === 'keep')
      refs.set(c.transcript.id, { id: c.transcript.id, start: c.transcript.start, status: 'reused' });
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      const outcome = await writeReport(c, env, run).catch((err: unknown): ReportOutcome =>
        fail(err instanceof Error ? err.message : String(err), {
          costUsd: null,
          ms: null,
          tokens: null,
        }),
      );
      const spent = outcome.kind === 'done' ? outcome.report.run : outcome;
      if (spent.costUsd !== null) costUsd = (costUsd ?? 0) + spent.costUsd;
      if (spent.tokens !== null) tokens = (tokens ?? 0) + spent.tokens;
      const ref: SessionReportRef = { id: c.transcript.id, start: c.transcript.start, status: 'analysed' };
      if (outcome.kind === 'done') await writeSessionReport(book, outcome.report);
      // A session that went on since its report: the older report still tells most of it.
      else if (await readSessionReport(book, c.transcript.id))
        Object.assign(ref, { status: 'reused', reason: `not brought up to date: ${outcome.reason}` });
      else Object.assign(ref, { status: 'failed', reason: outcome.reason });
      refs.set(c.transcript.id, ref);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  // In the order of the sessions.
  const ordered = plan.candidates.map((c) => refs.get(c.transcript.id)).filter((x): x is SessionReportRef => !!x);
  return { refs: ordered, costUsd, durationMs: Date.now() - started, tokens };
}

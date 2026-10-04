import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RetroBook } from './retro';

/**
 * The reports on the agent's sessions, one per session, written for the retros of a project and kept
 * for the next ones (a session already reported is not analysed again, unless it went on since):
 *
 * ```text
 * .local-review/retros/sessions/<session-id>.json   one report per session (rewritten when it grows)
 * ```
 *
 * A report holds what was computed without a model from the agent's records (`analytics`: signals
 * pointing at moments of the conversation) and what a model made of them (`analysis`: the signals
 * judged, patterns, observations on the setup, leads). Both are written by the agent's adapter: core
 * keeps them as they are, and only reads the strings and the moments they cite. The keep-history
 * setting does not touch them: it is about deleted threads, and these are data of the retros.
 */
export const SESSION_REPORT_VERSION = 1;
export const SESSION_REPORTS_DIR = 'sessions';

export interface SessionReport {
  v: number;
  session: string;
  /** The agent whose session it is, e.g. "Claude Code". */
  agent: string;
  /** The folder it was started in. */
  folder: string;
  start: string;
  end: string;
  /** How much of the session's records it covers: a session that went on since is analysed again. */
  covered: { lines: number };
  generatedAt: string;
  model: string | null;
  /** What writing it took, when known. */
  run: { costUsd: number | null; durationMs: number | null; tokens: number | null };
  /** The moments the analysis cites, checked by program against the session's records. */
  checks: { citedMoments: number; unknownMoments: string[] };
  /** Written by a model: summary, goal, outcome, signals judged, patterns, setup observations, leads. */
  analysis: Record<string, unknown>;
  /** Computed without a model from the agent's records. */
  analytics: Record<string, unknown>;
}

/** What a retro records of the reports it reads. */
export interface SessionReportRef {
  id: string;
  start: string;
  /** `analysed` for this retro, `reused` (already up to date), or `failed` (the retro goes on without it). */
  status: 'analysed' | 'reused' | 'failed';
  /** Why it failed, or why an older report was kept. */
  reason?: string;
}

export const reportsDir = (book: RetroBook): string => join(book.dir, SESSION_REPORTS_DIR);

const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;
const reportFile = (book: RetroBook, id: string) => {
  if (!SESSION_ID.test(id) || id.startsWith('.')) throw new Error(`Invalid session id: ${id}`);
  return join(reportsDir(book), `${id}.json`);
};

/** Writes the report of a session (replacing an older one). Returns its file. */
export async function writeSessionReport(book: RetroBook, report: SessionReport): Promise<string> {
  const file = reportFile(book, report.session);
  await mkdir(reportsDir(book), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(report, null, 1) + '\n');
  await rename(tmp, file);
  return file;
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** The report of a session; `null` when there is none, or it cannot be read. */
export async function readSessionReport(book: RetroBook, id: string): Promise<SessionReport | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(reportFile(book, id), 'utf8'));
  } catch {
    return null;
  }
  if (!isRecord(raw) || typeof raw.v !== 'number' || raw.session !== id) return null;
  if (!isRecord(raw.analysis) || !isRecord(raw.analytics)) return null;
  return raw as unknown as SessionReport;
}

/** The ids of the sessions that have a report. */
export async function sessionReportIds(book: RetroBook): Promise<string[]> {
  const names = await readdir(reportsDir(book)).catch(() => [] as string[]);
  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.slice(0, -'.json'.length))
    .sort();
}

/** Every string of a value, one per line. */
function strings(x: unknown, out: string[] = []): string[] {
  if (typeof x === 'string') out.push(x);
  else if (Array.isArray(x)) for (const y of x) strings(y, out);
  else if (isRecord(x)) for (const y of Object.values(x)) strings(y, out);
  return out;
}

/** The text of a report's analysis: excerpts cited from a report must be words of it. */
export const reportText = (r: SessionReport): string => strings(r.analysis).join('\n');

/** The moments (`uuid`s) a value cites: `uuid` fields, and the items of `evidence` lists. */
export function citedMoments(node: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(node)) for (const x of node) citedMoments(x, out);
  else if (isRecord(node))
    for (const [k, v] of Object.entries(node)) {
      if (k === 'uuid' && typeof v === 'string') out.add(v);
      else if (k === 'evidence' && Array.isArray(v)) {
        for (const x of v) if (typeof x === 'string') out.add(x);
      } else citedMoments(v, out);
    }
  return out;
}

/** The moments a report knows: those its analysis cites (checked) and those of its signals. */
export const reportMoments = (r: SessionReport): Set<string> =>
  citedMoments(r.analytics.signals, citedMoments(r.analysis));

/** The parts of an analysis the retro's analysis reads (the signals judged not relevant are left out). */
function analysisForRetro(a: Record<string, unknown>): Record<string, unknown> {
  const signals = isRecord(a.signals) ? a.signals : {};
  const relevant: Record<string, unknown> = {};
  for (const [family, names] of Object.entries(signals)) {
    if (!isRecord(names)) continue;
    for (const [name, s] of Object.entries(names)) {
      if (!isRecord(s) || !Array.isArray(s.relevant) || s.relevant.length === 0) continue;
      relevant[`${family}.${name}`] = { occurrences: s.occurrences, relevant: s.relevant, note: s.note };
    }
  }
  const { signals: _signals, session_id: _id, ...rest } = a;
  return { ...rest, relevant_signals: relevant };
}

/** The reports, as the retro's analysis reads them. */
export function renderSessionReports(reports: readonly SessionReport[], dir: string): string[] {
  if (reports.length === 0) return [];
  return [
    `## Reports on the agent's sessions (${reports.length})`,
    '',
    `One report per session of the period, written by a model from the session's records: what was done, the signals judged relevant (each pointing at a moment of the conversation by its "uuid"), patterns that recur, observations on the setup, leads. The signals judged not relevant are left out; the whole report is in its file (${dir}/<session>.json), with the signals computed without a model ("analytics"): read it when a moment needs more context. Cite a report with "sessions": [{"session": "<id>", "excerpt": "<words copied from the report>", "moments": ["<uuid>", …]}].`,
    '',
    ...reports.flatMap((r) => [
      `### Session ${r.session} · ${r.start} to ${r.end} · ${r.folder}`,
      `${typedPrompts(r)} prompts typed by the user · ${(r.analytics.agents as unknown[] | undefined)?.length ?? 1} agent(s), the session and its sub-agents`,
      '```json',
      JSON.stringify(analysisForRetro(r.analysis), null, 1),
      '```',
      '',
    ]),
  ];
}

const typedPrompts = (r: SessionReport): number => {
  const counts = r.analytics.counts;
  return isRecord(counts) && typeof counts.typed_prompts === 'number' ? counts.typed_prompts : 0;
};

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RetroBook } from './retro';

/**
 * The agent's sessions a retro reads, next to the review threads: those of the project and of the
 * period only, as the agent's adapter found them in the agent's own records (Claude Code's
 * `/insights`: facts counted without a model, and a summary written by a model). The adapter writes
 * them in the retro's folder (`sessions.json`) and records which ones in the retro's journal: the
 * analysis cites them, and the guard rails check the citations against that list.
 */
export interface RetroSession {
  id: string;
  /** When it started (ISO). */
  start: string;
  /** The folder it was started in. */
  folder: string;
  /** Facts counted without a model: messages, interruptions, tool errors… (name → value). */
  facts: Record<string, string | number | boolean>;
  /** The summary written by a model, as the agent's records give it; `null` when there is none. */
  summary: Record<string, unknown> | null;
}

/** A session, as the retro's journal records it. */
export interface RetroSessionRef {
  id: string;
  start: string;
  /** Whether it has a summary written by a model. */
  summary: boolean;
}

/** A session cited as evidence by a proposal, with the excerpt of its summary that shows it. */
export interface SessionEvidence {
  session: string;
  start: string;
  /** Words of the session's summary or report, as written there (never the analysis' own). */
  excerpt: string;
  /** Moments of the session's conversation it points at (`uuid`s cited by its report). */
  moments?: string[];
}

export const SESSIONS_FILE = 'sessions.json';

/**
 * Writes the sessions of a retro in its folder, and records which ones (with what reading them cost)
 * in its journal. Returns the file.
 */
export async function recordRetroSessions(
  book: RetroBook,
  retroId: string,
  source: string,
  sessions: readonly RetroSession[],
  run: { costUsd: number | null; durationMs: number | null } = { costUsd: null, durationMs: null },
): Promise<string> {
  const file = join(await book.workDir(retroId), SESSIONS_FILE);
  await writeFile(file, JSON.stringify({ source, sessions }, null, 2) + '\n');
  await book.record(retroId, [
    {
      type: 'retro.sessions',
      source,
      sessions: sessions.map((s) => ({ id: s.id, start: s.start, summary: s.summary !== null })),
      ...(run.costUsd !== null ? { costUsd: run.costUsd } : {}),
      ...(run.durationMs !== null ? { durationMs: run.durationMs } : {}),
    },
  ]);
  return file;
}

/** The sessions written for a retro; none when there is no file (or an unreadable one). */
export async function readRetroSessions(book: RetroBook, retroId: string): Promise<RetroSession[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(await book.workDir(retroId), SESSIONS_FILE), 'utf8'));
  } catch {
    return [];
  }
  const list = (raw as { sessions?: unknown } | null)?.sessions;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (s): s is RetroSession =>
      typeof s === 'object' && s !== null && typeof s.id === 'string' && typeof s.start === 'string',
  );
}

/** The text of a session's summary: every string in it, one per line. */
export function summaryText(summary: Record<string, unknown> | null): string {
  if (!summary) return '';
  const out: string[] = [];
  const walk = (x: unknown) => {
    if (typeof x === 'string') out.push(x);
    else if (Array.isArray(x)) x.forEach(walk);
    else if (typeof x === 'object' && x !== null) Object.values(x).forEach(walk);
  };
  walk(summary);
  return out.join('\n');
}

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Whether an excerpt is words of a summary, as written there: spaces aside, and without the "…" or
 * quotes around a cut excerpt.
 */
export function excerptOf(excerpt: string, text: string): boolean {
  const e = flat(excerpt.replace(/^[\s"'“«…]+|[\s"'”»…]+$/g, '').replace(/\.{3}$/, ''));
  return e.length > 0 && flat(text).includes(e);
}

/** The part of a summary shown when a proposal cites the session without an excerpt. */
export function defaultExcerpt(summary: Record<string, unknown> | null): string {
  for (const key of ['friction_detail', 'brief_summary', 'underlying_goal']) {
    const v = summary?.[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** The sessions, as the analysis reads them. */
export function renderSessions(sessions: readonly RetroSession[]): string[] {
  if (sessions.length === 0) return [];
  const withSummary = sessions.filter((s) => s.summary).length;
  return [
    `## The agent's sessions in this project (${sessions.length}, ${withSummary} with a summary written by a model)`,
    '',
    'What happened in the sessions of the period, from the agent\'s own records: facts counted without a model, and a summary written by a model (not the user\'s words). Cite a session with "sessions": [{"session": "<id>", "excerpt": "<words copied from its summary>"}].',
    '',
    ...sessions.flatMap((s) => {
      const facts = Object.entries(s.facts)
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join(' · ');
      return [
        `### Session ${s.id} · ${s.start} · ${s.folder}`,
        ...(facts ? [`Facts: ${facts}`] : []),
        s.summary ? 'Summary:\n```json\n' + JSON.stringify(s.summary, null, 2) + '\n```' : 'No summary.',
        '',
      ];
    }),
  ];
}

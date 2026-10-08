import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { projectAgentSessions } from './agentSessions';
import { DEFAULT_CONFIG, readConfig, type MachineConfig } from './config';
import { projectHistory } from './project';
import { readRetros, RETROS_DIR, type RetroState } from './retro';
import { LOOSE_ROOT } from './sessions';
import { STORE_DIR } from './types';
import { worktreeInfo, worktreesOf } from './worktrees';

/**
 * The cadence of retros: when is a retro worth it? Measured in days since the last retro and in
 * size of the threads since then (not in number of threads), with a retro a week as the mark. The
 * agent sessions of the project count too: a project without review threads has its retros.
 */
export interface CadenceThresholds {
  /** A retro is due this many days after the last one… */
  days: number;
  /** …or sooner, once the threads since the last one weigh this many bytes… */
  bytes: number;
  /** …and never later than this many days, whatever `days` says. */
  maxDays: number;
}

export const DEFAULT_CADENCE: CadenceThresholds = thresholdsOf(DEFAULT_CONFIG);

export function thresholdsOf(
  c: Pick<MachineConfig, 'retroReminderDays' | 'retroReminderSizeKB' | 'retroReminderMaxDays'>,
): CadenceThresholds {
  return { days: c.retroReminderDays, bytes: c.retroReminderSizeKB * 1000, maxDays: c.retroReminderMaxDays };
}

/** Why a retro is due: enough days, enough data, or the latest day to keep the agent conversations. */
export type DueReason = 'days' | 'size' | 'max-days';

export interface RetroCadence {
  /** The project folder. */
  root: string;
  /** The last finished retro of this folder or of a folder above it (its threads include these). */
  lastRetro: { id: string; root: string; until: string } | null;
  /**
   * Where the count starts: the end of the last retro's period, else the first thread or agent
   * session of the project (`first` says which).
   */
  since: string | null;
  first?: 'thread' | 'session';
  /** Whole days since then. */
  days: number;
  /** Threads with activity since then, and the size of their journals. */
  threads: number;
  bytes: number;
  /** Agent sessions started since then, as the agents' adapters recorded them. */
  sessions: number;
  thresholds: CadenceThresholds;
  /** A retro is worth it now: there is something to look back at, and enough of it, or for long enough. */
  due: boolean;
  reasons: DueReason[];
}

const DAY = 86_400_000;

/**
 * How things stand for a retro of the project `root` (see `retroCadence` for the rules). `null` for
 * the files outside any folder and for the root of the file system, which are no project.
 */
export async function retroCadence(
  root: string,
  opts: { env?: Record<string, string | undefined>; now?: number; thresholds?: CadenceThresholds } = {},
): Promise<RetroCadence | null> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  const dir = resolve(root);
  if (dir === LOOSE_ROOT || dirname(dir) === dir) return null;
  const thresholds = opts.thresholds ?? thresholdsOf(await readConfig(env));
  const last = await lastRetroCovering(dir);
  let since: number | null = last ? Date.parse(last.until) : null;
  // Just after the last retro, as the next retro will read.
  const history = await projectHistory(dir, { since: since === null ? null : new Date(since + 1), env });
  const threads = history.stores.flatMap((s) => s.threads);
  const sessions = await projectAgentSessions(dir, since === null ? null : new Date(since).toISOString(), env);
  let first: RetroCadence['first'];
  if (since === null && threads.length + sessions.length > 0) {
    const thread = threads.reduce((x, t) => Math.min(x, Date.parse(t.createdAt)), Infinity);
    const session = sessions.reduce((x, t) => Math.min(x, Date.parse(t.startedAt)), Infinity);
    [since, first] = thread <= session ? [thread, 'thread'] : [session, 'session'];
  }
  const days = since === null ? 0 : Math.max(0, Math.floor((now - since) / DAY));
  const reasons: DueReason[] = [];
  if (threads.length + sessions.length > 0) {
    if (days >= Math.min(thresholds.days, thresholds.maxDays)) reasons.push('days');
    if (history.bytes >= thresholds.bytes) reasons.push('size');
    if (days >= thresholds.maxDays) reasons.push('max-days');
  }
  return {
    root: dir,
    lastRetro: last ? { id: last.id, root: last.root, until: last.until } : null,
    since: since === null ? null : new Date(since).toISOString(),
    ...(first ? { first } : {}),
    days,
    threads: threads.length,
    bytes: history.bytes,
    sessions: sessions.length,
    thresholds,
    due: reasons.length > 0,
    reasons,
  };
}

/**
 * The last finished retro whose project holds `dir`: a retro of the folder itself, or of a folder
 * above it (a project includes its subfolders). Retros are kept in the store of their project, or
 * at the top of its git worktree: both are at or above the project, so looking up is enough. In a
 * git repository, a project includes the other worktrees of the repository too (they share their
 * threads): a retro of the same folder in another worktree, or above it, covers this one.
 */
export async function lastRetroCovering(dir: string): Promise<RetroState | null> {
  return lastFinished(await retrosCovering(dir));
}

/** Every retro, finished or not, whose project holds `dir` (see `lastRetroCovering`). */
export async function retrosCovering(dir: string): Promise<RetroState[]> {
  const target = resolve(dir);
  const real = await realpath(target).catch(() => target);
  const found = await retrosAbove([target, real]);
  const info = await worktreeInfo(real); // never fails: `null` outside git
  if (info) {
    const rel = relative(info.worktree, real);
    if (!rel.startsWith('..') && !isAbsolute(rel)) {
      for (const wt of await worktreesOf(real)) {
        if (wt === info.worktree) continue;
        found.push(...(await retrosAbove([join(wt, rel)])));
      }
    }
  }
  const seen = new Set<string>();
  return found.filter((r) => !seen.has(r.id) && seen.add(r.id));
}

const lastFinished = (retros: readonly RetroState[]): RetroState | null =>
  retros
    .filter((r) => r.finishedAt !== null)
    .reduce<RetroState | null>((a, r) => (!a || r.until > a.until ? r : a), null);

/** The retros kept at or above the first of `dirs` whose project holds one of them. */
async function retrosAbove(dirs: readonly string[]): Promise<RetroState[]> {
  const covers = (r: string) => dirs.some((d) => d === r || d.startsWith(r.endsWith(sep) ? r : r + sep));
  const found: RetroState[] = [];
  for (let d = dirs[0]!; ; d = dirname(d)) {
    for (const r of await readRetros(join(d, STORE_DIR, RETROS_DIR)).catch(() => [])) {
      const rootReal = await realpath(r.root).catch(() => r.root);
      if (covers(r.root) || covers(rootReal)) found.push(r);
    }
    if (dirname(d) === d) return found;
  }
}

/** What retros have not read yet: see `retroReading`. */
export interface RetroReading {
  /** For each project with a retro: the end of its last finished one (`null`: none finished yet). */
  until: (string | null)[];
  /** The threads read by retros started and not finished. */
  reading: Set<string>;
}

/**
 * What the retros of the projects holding `dirs` have not read yet, for a clean-up that must not
 * get ahead of them: the threads active after the end of the last finished retro (the next one
 * reads them), and those of a retro started and not finished. `null` when none of these projects
 * ever had a retro: nothing to keep for them.
 */
export async function retroReading(dirs: readonly string[]): Promise<RetroReading | null> {
  const until: (string | null)[] = [];
  const reading = new Set<string>();
  for (const dir of dirs) {
    const retros = await retrosCovering(dir);
    if (retros.length === 0) continue;
    until.push(lastFinished(retros)?.until ?? null);
    for (const r of retros) if (r.finishedAt === null) for (const id of r.threads) reading.add(id);
  }
  return until.length === 0 ? null : { until, reading };
}

/** Whether a retro still has to read a thread (see `retroReading`). */
export function unreadByRetro(reading: RetroReading, id: string, lastActivityAt: string): boolean {
  if (reading.reading.has(id)) return true;
  // A project whose retros are all unfinished: they read what they read, the rest waits for one.
  return reading.until.some((u) => u === null || lastActivityAt > u);
}

/** A size, as people read it: `640.0 KB`, `1.2 MB` (1 KB = 1,000 bytes). */
export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)} KB`;
  return `${(n / 1_000_000).toFixed(1)} MB`;
}

/**
 * One line on the cadence, e.g. "8 days, 1.2 MB of review threads (45) and 12 agent sessions since
 * the last retro (2026-09-25)", or "3 days, 2.1 KB of review threads (4) and 2 agent sessions since
 * the first thread (2026-09-30), no retro yet".
 */
export function cadenceSummary(c: RetroCadence): string {
  const day = (iso: string) => iso.slice(0, 10);
  const days = `${c.days} day${c.days === 1 ? '' : 's'}`;
  const sessions = c.sessions;
  const data =
    `${formatBytes(c.bytes)} of review threads (${c.threads})` +
    ` and ${sessions} agent session${sessions === 1 ? '' : 's'}`;
  if (c.lastRetro) return `${days}, ${data} since the last retro (${day(c.lastRetro.until)})`;
  return c.since
    ? `${days}, ${data} since the first ${c.first === 'session' ? 'agent session' : 'thread'} (${day(c.since)}), no retro yet`
    : `${data}, no retro yet`;
}

/** Why it is due, in words. */
export function dueReasons(c: RetroCadence): string[] {
  const t = c.thresholds;
  return c.reasons.map((r) =>
    r === 'days'
      ? `${c.days} days since ${c.lastRetro ? 'the last retro' : c.first === 'session' ? 'the first agent session' : 'the first thread'} (reminder at ${Math.min(t.days, t.maxDays)})`
      : r === 'size'
        ? `${formatBytes(c.bytes)} of threads to look back at (reminder at ${formatBytes(t.bytes)})`
        : `${t.maxDays} days or more: agents delete their conversations after a while (often 30 days), and the retro reads back those linked to replies`,
  );
}

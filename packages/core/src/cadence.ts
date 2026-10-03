import { realpath } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { DEFAULT_CONFIG, readConfig, type MachineConfig } from './config';
import { projectHistory } from './project';
import { readRetros, RETROS_DIR, type RetroState } from './retro';
import { LOOSE_ROOT } from './sessions';
import { STORE_DIR } from './types';

/**
 * The cadence of retros: when is a retro worth it? Measured in days since the last retro and in
 * size of the threads since then (not in number of threads), with a retro a week as the mark.
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
  /** Where the count starts: the end of the last retro's period, else the first thread of the project. */
  since: string | null;
  /** Whole days since then. */
  days: number;
  /** Threads with activity since then, and the size of their journals. */
  threads: number;
  bytes: number;
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
  if (since === null && threads.length > 0) since = Math.min(...threads.map((t) => Date.parse(t.createdAt)));
  const days = since === null ? 0 : Math.max(0, Math.floor((now - since) / DAY));
  const reasons: DueReason[] = [];
  if (threads.length > 0) {
    if (days >= Math.min(thresholds.days, thresholds.maxDays)) reasons.push('days');
    if (history.bytes >= thresholds.bytes) reasons.push('size');
    if (days >= thresholds.maxDays) reasons.push('max-days');
  }
  return {
    root: dir,
    lastRetro: last ? { id: last.id, root: last.root, until: last.until } : null,
    since: since === null ? null : new Date(since).toISOString(),
    days,
    threads: threads.length,
    bytes: history.bytes,
    thresholds,
    due: reasons.length > 0,
    reasons,
  };
}

/**
 * The last finished retro whose project holds `dir`: a retro of the folder itself, or of a folder
 * above it (a project includes its subfolders). Retros are kept in the store of their project, or
 * at the top of its git worktree: both are at or above the project, so looking up is enough.
 */
export async function lastRetroCovering(dir: string): Promise<RetroState | null> {
  const target = resolve(dir);
  const real = await realpath(target).catch(() => target);
  const covers = (r: string) => [target, real].some((d) => d === r || d.startsWith(r.endsWith(sep) ? r : r + sep));
  let best: RetroState | null = null;
  for (let d = target; ; d = dirname(d)) {
    for (const r of await readRetros(join(d, STORE_DIR, RETROS_DIR)).catch(() => [])) {
      if (r.finishedAt === null) continue;
      const rootReal = await realpath(r.root).catch(() => r.root);
      if ((covers(r.root) || covers(rootReal)) && (!best || r.until > best.until)) best = r;
    }
    if (dirname(d) === d) return best;
  }
}

/** A size, as people read it: `640.0 KB`, `1.2 MB` (1 KB = 1,000 bytes). */
export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)} KB`;
  return `${(n / 1_000_000).toFixed(1)} MB`;
}

/** One line on the cadence, e.g. "8 days and 1.2 MB of review threads (45) since the last retro (2026-09-25)". */
export function cadenceSummary(c: RetroCadence): string {
  const day = (iso: string) => iso.slice(0, 10);
  const days = `${c.days} day${c.days === 1 ? '' : 's'}`;
  const data = `${formatBytes(c.bytes)} of review threads (${c.threads})`;
  return c.lastRetro
    ? `${days} and ${data} since the last retro (${day(c.lastRetro.until)})`
    : `no retro yet: ${data}${c.since ? ` since the first one, ${days} ago (${day(c.since)})` : ''}`;
}

/** Why it is due, in words. */
export function dueReasons(c: RetroCadence): string[] {
  const t = c.thresholds;
  return c.reasons.map((r) =>
    r === 'days'
      ? `${c.days} days since ${c.lastRetro ? 'the last retro' : 'the first thread'} (reminder at ${Math.min(t.days, t.maxDays)})`
      : r === 'size'
        ? `${formatBytes(c.bytes)} of threads to look back at (reminder at ${formatBytes(t.bytes)})`
        : `${t.maxDays} days or more: agents delete their conversations after a while (often 30 days), and the retro reads back those linked to replies`,
  );
}

import { realpath, rm, stat } from 'node:fs/promises';
import { unreadByRetro, type RetroReading } from './cadence';
import type { ThreadHistory } from './history';
import { projectStores, type ProjectStore } from './project';
import { storeAt } from './sessions';
import { Store } from './store';

/**
 * Managing the threads of a project (see `projectStores`): archive or unarchive them, find the old
 * ones, and delete them for good. The editor and `lr` share these functions, so that both act on
 * the same threads as `lr history` shows.
 */

/** A thread of a project, once, with every store that holds its journal. */
export interface ProjectThread {
  /** Its history, from its longest journal (journals only grow). */
  thread: ThreadHistory;
  /** The store of that journal. */
  store: ProjectStore;
  /** Every store holding a journal of the thread: the live ones first, then the copies saved from worktrees. */
  copies: Store[];
  /** How many of `copies` are live stores (the others are copies saved from worktrees). */
  live: number;
}

type Env = Record<string, string | undefined>;

const storeOf = (s: ProjectStore, env: Env): Store => (s.saved ? new Store(s.root, s.saved.dir) : storeAt(s.root, env));

/**
 * Every thread of one or more projects (the history's threads, whatever their state), once each,
 * oldest first. Threads holding only drafts are not in it: they are the user's review in progress.
 */
export async function projectThreads(roots: readonly string[], env: Env = process.env): Promise<ProjectThread[]> {
  const found: { s: ProjectStore; store: Store }[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    for (const s of await projectStores(root, env)) {
      const store = storeOf(s, env);
      const key = await realpath(store.dir).catch(() => store.dir);
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ s, store });
    }
  }
  // Live stores first: on a tie between a journal and its copy, the live one wins.
  found.sort((a, b) => Number(a.s.origin === 'saved') - Number(b.s.origin === 'saved'));
  const loaded = await Promise.all(found.map(async (f) => ({ ...f, threads: (await f.store.loadHistory()).threads })));
  const byId = new Map<string, ProjectThread>();
  for (const { s, store, threads } of loaded) {
    for (const thread of threads) {
      const known = byId.get(thread.id);
      const live = s.origin === 'saved' ? 0 : 1;
      if (!known) byId.set(thread.id, { thread, store: s, copies: [store], live });
      else {
        known.copies.push(store);
        known.live += live;
        if (thread.bytes > known.thread.bytes) Object.assign(known, { thread, store: s });
      }
    }
  }
  return [...byId.values()].sort(
    (a, b) => a.thread.createdAt.localeCompare(b.thread.createdAt) || a.thread.id.localeCompare(b.thread.id),
  );
}

/**
 * A date given by people: `2026-10-01` (local midnight), an ISO date and time, or `<n>d` (n days
 * ago). `null` when it is none of these.
 */
export function parseDateArg(value: string, now = Date.now()): Date | null {
  const days = /^(\d+)d$/.exec(value.trim());
  if (days) return new Date(now - Number(days[1]) * 86_400_000);
  // Only ISO dates: `new Date()` also takes "7" (the year 2001) or "2026-02-30" (March 2).
  const day = /^(\d{4})-(\d{2})-(\d{2})(T.+)?$/.exec(value.trim());
  if (!day) return null;
  const date = new Date(day[4] ? value.trim() : `${day[1]}-${day[2]}-${day[3]}T00:00:00`);
  const exists = new Date(`${day[1]}-${day[2]}-${day[3]}T00:00:00Z`).getUTCDate() === +day[3]!;
  return exists && !Number.isNaN(date.getTime()) ? date : null;
}

/**
 * A date given to `parseDateArg`, as people read it: "2026-08-04 (60 days)" for `60d`, the day for a
 * day, the day and time for a date and time.
 */
export function dateArgLabel(value: string, date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const days = /^(\d+)d$/.exec(value.trim());
  if (days) return `${day} (${days[1]} day${days[1] === '1' ? '' : 's'})`;
  return /T/.test(value) ? `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}` : day;
}

const before = (at: string | null, date: Date): boolean => at !== null && Date.parse(at) < date.getTime();

/**
 * The resolved threads, not archived yet, that were resolved before `date`. A thread holding a draft
 * reply of the user's review in progress is left out: it is about to be reopened.
 */
export function resolvedBefore(threads: readonly ProjectThread[], date: Date): ProjectThread[] {
  return threads.filter(
    ({ thread: t }) => t.state === 'resolved' && t.archivedAt === null && !t.hasDrafts && before(t.resolvedAt, date),
  );
}

/** The archived threads, most recently archived first. */
export function archivedThreads(threads: readonly ProjectThread[]): ProjectThread[] {
  return threads
    .filter((t) => t.thread.archivedAt !== null)
    .sort((a, b) => b.thread.archivedAt!.localeCompare(a.thread.archivedAt!));
}

/** Whether a thread is finished: resolved, archived or deleted. The others still wait for someone. */
export const isFinished = (t: ThreadHistory): boolean =>
  t.state === 'resolved' || t.state === 'deleted' || t.archivedAt !== null;

export interface PurgePlan {
  /** Finished threads where nothing was published since the date: deleted for good if confirmed. */
  threads: ProjectThread[];
  /**
   * Threads also quiet since the date but still in progress (open, needs-info, addressed, or with a
   * draft reply of the user's review in progress): kept.
   */
  inProgress: ProjectThread[];
  /** Finished and quiet threads that a retro has not read yet: kept for it. */
  unread: ProjectThread[];
  /** Whether the project had a retro: without one, no thread is kept for retros. */
  retro: boolean;
  /** Size of the threads to delete, in bytes (one journal each: copies saved from worktrees are not counted). */
  bytes: number;
}

/**
 * What a purge before `date` would delete: the finished threads (resolved, archived or deleted)
 * where nothing was published since `date`. Threads still in progress are never purged, however
 * old: the user resolves or deletes them first. Nor are threads holding a draft of the user's
 * review in progress: deleting them would lose that draft. Nor, in a project that had a retro
 * (`reading`, from `retroReading`), the threads a retro has not read yet.
 */
export function purgePlan(threads: readonly ProjectThread[], date: Date, reading?: RetroReading | null): PurgePlan {
  const quiet = threads.filter((t) => before(t.thread.lastActivityAt, date));
  const purgeable = (t: ProjectThread) => isFinished(t.thread) && !t.thread.hasDrafts;
  const unread = (t: ProjectThread) => !!reading && unreadByRetro(reading, t.thread.id, t.thread.lastActivityAt);
  const purged = quiet.filter((t) => purgeable(t) && !unread(t));
  return {
    threads: purged,
    inProgress: quiet.filter((t) => !purgeable(t)),
    unread: quiet.filter((t) => purgeable(t) && unread(t)),
    retro: !!reading,
    bytes: purged.reduce((n, t) => n + t.thread.bytes, 0),
  };
}

/** The history kept for a project: what `eraseHistory` erases, when the user stops keeping it. */
export interface HistoryPlan {
  /** The deleted threads: their journals, copies included. */
  deleted: ProjectThread[];
  /** The copies of threads saved from worktrees: their whole folder (journals, reviews, origin). */
  saved: ProjectStore[];
}

/** The history kept for the projects `roots`: deleted threads, and threads saved from worktrees. */
export async function historyPlan(roots: readonly string[], env: Env = process.env): Promise<HistoryPlan> {
  const deleted = (await projectThreads(roots, env)).filter((t) => t.thread.state === 'deleted');
  const saved: ProjectStore[] = [];
  const seen = new Set<string>();
  for (const root of roots)
    for (const s of await projectStores(root, env))
      if (s.saved && !seen.has(s.saved.dir)) {
        seen.add(s.saved.dir);
        saved.push(s);
      }
  return { deleted, saved };
}

/** Erases the history of a `historyPlan`: nothing is left of it. Returns how many threads and saved copies went. */
export async function eraseHistory(plan: HistoryPlan): Promise<{ threads: number; saved: number }> {
  const result = await purgeThreads(plan.deleted);
  if (result.failed.length > 0) throw new Error(result.failed[0]!.error);
  let saved = 0;
  for (const s of plan.saved) {
    if (await stat(s.saved!.dir).catch(() => null)) saved++;
    await rm(s.saved!.dir, { recursive: true, force: true });
  }
  return { threads: result.done.length, saved };
}

/** The history kept, as people read it: "3 deleted threads and 1 copy of worktree threads"; `null` when none. */
export function historySummary(deleted: number, saved: number): string | null {
  const parts = [
    ...(deleted > 0 ? [`${deleted} deleted thread${deleted === 1 ? '' : 's'}`] : []),
    ...(saved > 0 ? [`${saved} ${saved === 1 ? 'copy' : 'copies'} of worktree threads`] : []),
  ];
  return parts.length === 0 ? null : parts.join(' and ');
}

/**
 * Erases a thread just deleted in `store`, when the history is not kept: its journal, and its
 * copies saved from worktrees. Nothing is left of it, not even in `lr history`.
 */
export async function eraseThread(store: Store, id: string, env: Env = process.env): Promise<void> {
  await store.purgeThread(id);
  const copies = (await projectThreads([store.root], env)).filter((t) => t.thread.id === id);
  const result = await purgeThreads(copies);
  if (result.failed.length > 0) throw new Error(result.failed[0]!.error);
}

export interface BatchResult {
  /** Threads changed (in at least one of their stores). */
  done: string[];
  /** Threads left as they were: already archived (when archiving), or not archived (when unarchiving). */
  unchanged: string[];
  /** Threads that could not be changed, with why. */
  failed: { id: string; error: string }[];
}

/**
 * Archives threads where they live. A copy saved from a worktree keeps the state of when it was
 * saved, like its other changes; when a thread is left only in copies (its worktree is gone), it
 * is archived there.
 */
export function archiveThreads(threads: readonly ProjectThread[]): Promise<BatchResult> {
  return inStores(threads, false, async (store, id) => {
    const was = (await store.loadThread(id)).state?.archived;
    await store.archiveThread(id);
    return was === false;
  });
}

/** Brings archived threads back, where they live (as `archiveThreads`). */
export function unarchiveThreads(threads: readonly ProjectThread[]): Promise<BatchResult> {
  return inStores(threads, false, async (store, id) => {
    const was = (await store.loadThread(id)).state?.archived;
    await store.unarchiveThread(id);
    return was === true;
  });
}

/** Deletes threads for good: every journal of each, copies saved from worktrees included. Nothing is left of them. */
export function purgeThreads(threads: readonly ProjectThread[]): Promise<BatchResult> {
  return inStores(threads, true, (store, id) => store.purgeThread(id));
}

/**
 * Runs `action` on the stores of each thread. `action` says whether it changed the thread there;
 * a thread changed nowhere, without error, is `unchanged`.
 */
async function inStores(
  threads: readonly ProjectThread[],
  everyCopy: boolean,
  action: (store: Store, id: string) => Promise<boolean>,
): Promise<BatchResult> {
  const result: BatchResult = { done: [], unchanged: [], failed: [] };
  for (const { thread, copies, live } of threads) {
    const errors: string[] = [];
    let changed = false;
    const stores = everyCopy || live === 0 ? copies : copies.slice(0, live);
    for (const store of stores) {
      try {
        if (await action(store, thread.id)) changed = true;
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (changed) result.done.push(thread.id);
    else if (errors.length === 0) result.unchanged.push(thread.id);
    else result.failed.push({ id: thread.id, error: errors[0]! });
  }
  return result;
}

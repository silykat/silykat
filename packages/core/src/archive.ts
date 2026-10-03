import { realpath } from 'node:fs/promises';
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

const before = (at: string | null, date: Date): boolean => at !== null && Date.parse(at) < date.getTime();

/** The resolved threads, not archived yet, that were resolved before `date`. */
export function resolvedBefore(threads: readonly ProjectThread[], date: Date): ProjectThread[] {
  return threads.filter(
    ({ thread: t }) => t.state === 'resolved' && t.archivedAt === null && before(t.resolvedAt, date),
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
  /** Threads also quiet since the date but still in progress (open, needs-info, addressed): kept. */
  inProgress: ProjectThread[];
  /** Size of the journals to delete (every copy), in bytes. */
  bytes: number;
}

/**
 * What a purge before `date` would delete: the finished threads (resolved, archived or deleted)
 * where nothing was published since `date`. Threads still in progress are never purged, however
 * old: the user resolves or deletes them first.
 */
export function purgePlan(threads: readonly ProjectThread[], date: Date): PurgePlan {
  const quiet = threads.filter((t) => before(t.thread.lastActivityAt, date));
  const purged = quiet.filter((t) => isFinished(t.thread));
  return {
    threads: purged,
    inProgress: quiet.filter((t) => !isFinished(t.thread)),
    bytes: purged.reduce((n, t) => n + t.thread.bytes, 0),
  };
}

export interface BatchResult {
  /** Threads changed (in at least one of their stores). */
  done: string[];
  /** Threads that could not be changed, with why. */
  failed: { id: string; error: string }[];
}

/**
 * Archives threads where they live. A copy saved from a worktree keeps the state of when it was
 * saved, like its other changes; when a thread is left only in copies (its worktree is gone), it
 * is archived there.
 */
export function archiveThreads(threads: readonly ProjectThread[]): Promise<BatchResult> {
  return inStores(threads, false, (store, id) => store.archiveThread(id));
}

/** Brings archived threads back, where they live (as `archiveThreads`). */
export function unarchiveThreads(threads: readonly ProjectThread[]): Promise<BatchResult> {
  return inStores(threads, false, (store, id) => store.unarchiveThread(id));
}

/** Deletes threads for good: every journal of each, copies saved from worktrees included. Nothing is left of them. */
export function purgeThreads(threads: readonly ProjectThread[]): Promise<BatchResult> {
  return inStores(threads, true, (store, id) => store.purgeThread(id));
}

async function inStores(
  threads: readonly ProjectThread[],
  everyCopy: boolean,
  action: (store: Store, id: string) => Promise<unknown>,
): Promise<BatchResult> {
  const result: BatchResult = { done: [], failed: [] };
  for (const { thread, copies, live } of threads) {
    const errors: string[] = [];
    const stores = everyCopy || live === 0 ? copies : copies.slice(0, live);
    for (const store of stores) {
      try {
        await action(store, thread.id);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (errors.length < stores.length) result.done.push(thread.id);
    else result.failed.push({ id: thread.id, error: errors[0] ?? 'unknown error' });
  }
  return result;
}

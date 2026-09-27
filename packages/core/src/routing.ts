import { isAbsolute, relative } from 'node:path';
import { sessionDirs, type Session } from './sessions';

/** Whether `inner` is `outer` itself or inside it. */
export function isWithin(inner: string, outer: string): boolean {
  const rel = relative(outer, inner);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Sessions that matter to some folders: working in, above or below one of them, or having written
 * a file inside one (e.g. specs kept in a separate folder).
 */
export function relevantSessions(sessions: readonly Session[], folders: readonly string[]): Session[] {
  return sessions.filter(
    (s) =>
      folders.some((f) => sessionDirs(s).some((d) => isWithin(d, f) || isWithin(f, d))) ||
      s.touched.some((file) => folders.some((f) => isWithin(file, f))),
  );
}

/**
 * Where a thread should go. `sure`: one session is clearly the one; `doubt`: several could be, the
 * user confirms `proposed` or picks another; `null`: no session works on it.
 */
export type Route = { sure: true; session: Session } | { sure: false; proposed: Session; candidates: Session[] } | null;

const latest = (sessions: Session[], key: (s: Session) => string): Session =>
  sessions.reduce((best, s) => (key(s) > key(best) ? s : best));

/**
 * Routes the thread of `file` (absolute path), in the store of the folder `root`:
 * 1. the session that wrote the file;
 * 2. else the session working closest to it: its folder (where it started, or where it works now)
 *    contains the file, and no other session's is deeper (a session in a worktree wins over one in a
 *    parent folder);
 * 3. else the session that matters to that store at all (working below it, or having written there).
 */
export function routeThread(sessions: readonly Session[], root: string, file: string): Route {
  const decide = (found: Session[], best: () => Session): Route =>
    found.length === 1 ? { sure: true, session: found[0]! } : { sure: false, proposed: best(), candidates: found };

  const writers = sessions.filter((s) => s.touched.includes(file));
  if (writers.length > 0) return decide(writers, () => latest(writers, (s) => s.writtenAt?.[file] ?? ''));

  const depthOf = (s: Session) =>
    Math.max(
      -1,
      ...sessionDirs(s)
        .filter((d) => isWithin(file, d))
        .map((d) => d.length),
    );
  const containing = sessions.filter((s) => depthOf(s) >= 0);
  if (containing.length > 0) {
    const depth = Math.max(...containing.map(depthOf));
    const closest = containing.filter((s) => depthOf(s) === depth);
    return decide(closest, () => latest(closest, (s) => s.startedAt));
  }

  const around = relevantSessions(sessions, [root]);
  if (around.length > 0) return decide(around, () => latest(around, (s) => s.startedAt));
  return null;
}

/** How the threads of one publication split between sessions. */
export interface DeliveryPlan {
  /** Threads whose session is clear, by session id. */
  sure: Map<string, string[]>;
  /** Threads for which the user has to confirm the session. */
  doubt: { threadIds: string[]; proposed: Session; candidates: Session[] } | null;
  /** Threads no session works on: they wait for one. */
  waiting: string[];
}

/**
 * Plans the delivery of published threads (`file`: absolute path of each thread's file). In doubt,
 * the session proposed is `lastUsed` (the last one that got comments from this folder) when it is
 * among the candidates.
 */
export function planDelivery(
  sessions: readonly Session[],
  root: string,
  threads: readonly { id: string; file: string }[],
  lastUsed?: string,
): DeliveryPlan {
  const plan: DeliveryPlan = { sure: new Map(), doubt: null, waiting: [] };
  const doubtful: string[] = [];
  const candidates = new Map<string, Session>();
  let proposed: Session | undefined;
  for (const t of threads) {
    const route = routeThread(sessions, root, t.file);
    if (route === null) plan.waiting.push(t.id);
    else if (route.sure) plan.sure.set(route.session.id, [...(plan.sure.get(route.session.id) ?? []), t.id]);
    else {
      doubtful.push(t.id);
      route.candidates.forEach((c) => candidates.set(c.id, c));
      proposed ??= route.proposed;
    }
  }
  if (proposed) {
    const all = [...candidates.values()];
    plan.doubt = { threadIds: doubtful, proposed: all.find((s) => s.id === lastUsed) ?? proposed, candidates: all };
  }
  return plan;
}

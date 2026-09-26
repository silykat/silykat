import { isAbsolute, relative } from 'node:path';
import type { Session } from './sessions';

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
      folders.some((f) => isWithin(s.cwd, f) || isWithin(f, s.cwd)) ||
      s.touched.some((file) => folders.some((f) => isWithin(file, f))),
  );
}

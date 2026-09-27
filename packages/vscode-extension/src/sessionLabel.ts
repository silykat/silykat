import { basename, relative } from 'node:path';
import type { Session } from '@local-review/core';

/** Where a session works now: where it moved to, else where it started. */
export const workingDir = (s: Session): string => s.workingDir ?? s.cwd;

/** Short name of a session, e.g. "Claude · feature-x", or "Claude · wt-test" outside git. */
export function sessionLabel(s: Session): string {
  return `${s.agent} · ${s.branch ?? basename(workingDir(s))}`;
}

/**
 * What tells two sessions apart, even started in the same folder: where each works, when it
 * started, and the last file it wrote.
 */
export function sessionDetail(s: Session, now = new Date()): string {
  const parts = [workingDir(s), `started ${startTime(s.startedAt, now)}`];
  const last = s.touched[s.touched.length - 1];
  if (last)
    parts.push(
      `last wrote ${relative(workingDir(s), last).startsWith('..') ? basename(last) : relative(workingDir(s), last)}`,
    );
  return parts.join(' · ');
}

function startTime(iso: string, now: Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'at an unknown time';
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === now.toDateString() ? `at ${time}` : `${d.toLocaleDateString()} ${time}`;
}

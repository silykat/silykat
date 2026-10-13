import { formatBytes, type PurgePlan, type ThreadHistory } from '@silykat/core';

// The texts of the archive and clean-up commands, without `vscode`, so that they can be unit-tested.

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A local day as people type it: `2026-10-03`. */
export const dayOf = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** A thread in a list: where it is, its state and when it was archived, the start of its first comment. */
export function threadItemText(t: ThreadHistory): { label: string; description: string; detail?: string } {
  const a = t.anchor;
  const first = t.conversation.find((e) => e.kind === 'comment');
  return {
    label: a.range ? `${a.path}:${a.range.startLine}` : a.path,
    description: [t.state, t.archivedAt ? `archived ${t.archivedAt.slice(0, 10)}` : ''].filter(Boolean).join(' · '),
    ...(first?.kind === 'comment' ? { detail: first.body.split('\n')[0] } : {}),
  };
}

/** The confirmation before archiving the threads resolved before `day`. */
export function archiveConfirmation(n: number, day: string): { message: string; detail: string; action: string } {
  return {
    message: `Archive ${plural(n, 'resolved thread')}?`,
    detail:
      `${n === 1 ? 'It was' : 'They were'} resolved before ${day}. Archived threads leave VS Code and stay in the ` +
      'history (slk review history) and in retros. silykat: Show Archived Threads brings them back.',
    action: `Archive ${plural(n, 'Thread')}`,
  };
}

/** What a purge keeps although as old: the threads still in progress, and those a retro has not read yet. */
export function keptText(plan: PurgePlan): string {
  const k = plan.inProgress.length;
  const u = plan.unread.length;
  return (
    (k === 0 ? '' : ` ${plural(k, 'older thread')} still in progress ${k === 1 ? 'is' : 'are'} kept.`) +
    (u === 0
      ? ''
      : ` ${plural(u, 'finished thread')} not read by a retro yet ${u === 1 ? 'is' : 'are'} kept for the next one.`) +
    (plan.retro ? '' : ' No retro in these folders yet: no thread is kept for one.')
  );
}

/** The confirmation before deleting threads for good: how many, and that it cannot be undone. */
export function purgeConfirmation(plan: PurgePlan, day: string): { message: string; detail: string; action: string } {
  const n = plan.threads.length;
  return {
    message: `Delete ${plural(n, 'thread')} permanently?`,
    detail:
      `${plural(n, 'finished thread')} (resolved, archived or deleted) with no activity since ${day}, ${formatBytes(plan.bytes)}: ` +
      `${n === 1 ? 'it' : 'they'} will be gone from the history and from retros, for good. This cannot be undone: ` +
      `run silykat: Export Threads first to keep a copy.${keptText(plan)}`,
    action: `Delete ${plural(n, 'Thread')}`,
  };
}

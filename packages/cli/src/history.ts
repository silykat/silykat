import {
  deletionLabel,
  formatBytes,
  HISTORY_STATES,
  storeLabel,
  topicLabel,
  versionTag,
  type BranchRef,
  type DeletionCounts,
  type HistoryEntry,
  type ProjectHistory,
  type StateCounts,
  type StoreOrigin,
  type ThreadHistory,
} from '@silykat/core';
import { fence } from './digest';

const ORIGIN: Record<StoreOrigin, string> = {
  root: 'this folder',
  below: 'subfolder',
  above: 'folder above',
  worktree: 'git worktree',
  saved: 'saved from a worktree',
};

const branchLabel = (b: BranchRef | null): string | null => (b ? topicLabel({ kind: 'branch', ...b }) : null);

const states = (c: StateCounts, d?: DeletionCounts): string =>
  HISTORY_STATES.map((s) => `${c[s]} ${s}${s === 'deleted' && d && c.deleted > 0 ? ` (${deletions(d)})` : ''}`).join(
    ' · ',
  );

/** Deleted threads by reason, e.g. "2 removed by the user, 1 with their branch". */
function deletions(d: DeletionCounts): string {
  const parts = [];
  if (d.user) parts.push(`${d.user} removed by the user`);
  if (d['branch-gone']) parts.push(`${d['branch-gone']} with their branch`);
  if (d.unknown) parts.push(`${d.unknown} reason unknown`);
  return parts.join(', ');
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The history of a project in markdown: a summary (per state, per store, size), then every thread. */
export function renderHistory(h: ProjectHistory): string {
  const period = h.since ? `Since ${h.since}` : 'Whole history';
  const parts = [
    `# silykat history — ${h.root}`,
    `${period} · ${plural(h.threads, 'thread')} · ${formatBytes(h.bytes)} of journals\n\n${states(h.states, h.deletions)}` +
      (h.archived > 0 ? ` — ${h.archived} archived` : ''),
  ];
  if (h.stores.length === 0) {
    parts.push('No comment store in this folder, its subfolders or the worktrees of its repositories.');
    return parts.join('\n\n');
  }
  const rows = h.stores.map(
    (s) =>
      `| ${storeLabel(s, h.root)} | ${ORIGIN[s.origin]} | ${s.threads.length} | ` +
      HISTORY_STATES.map((st) => s.states[st]).join(' | ') +
      ` | ${formatBytes(s.bytes)} |`,
  );
  parts.push(
    [
      '## Comment stores',
      '',
      `| Store | Found as | Threads | ${HISTORY_STATES.join(' | ')} | Size |`,
      `| --- | --- | --- | ${HISTORY_STATES.map(() => '---').join(' | ')} | --- |`,
      ...rows,
    ].join('\n'),
  );
  const warnings = h.stores.flatMap((s) => s.warnings.map((w) => `- ${storeLabel(s, h.root)}: ${w}`));
  if (warnings.length > 0) parts.push(['## Warnings', '', ...warnings].join('\n'));
  if (h.threads === 0) {
    parts.push(h.since ? 'No thread was active in this period.' : 'No thread yet.');
    return parts.join('\n\n');
  }
  parts.push('## Threads');
  for (const s of h.stores) for (const t of s.threads) parts.push(renderThreadHistory(t, storeLabel(s, h.root)));
  return parts.join('\n\n');
}

function where(t: ThreadHistory): string {
  const a = t.anchor;
  if (!a.range) return `${a.path} (whole file)`;
  return `${a.path}:${a.range.startLine}${a.range.endLine !== a.range.startLine ? `-${a.range.endLine}` : ''}`;
}

const who = (by: string, agent?: string) => (by === 'user' ? 'User' : (agent ?? 'Agent'));

function renderEntry(e: HistoryEntry): string {
  switch (e.kind) {
    case 'comment': {
      const notes = [e.at];
      if (e.publishedAt) notes.push(`submitted in a review ${e.publishedAt}`);
      if (e.editedAt) notes.push(`edited ${e.editedAt}`);
      if (e.deletedAt) notes.push(`deleted ${e.deletedAt}`);
      if (e.session) notes.push(`session ${e.session.id}${e.session.message ? `, message ${e.session.message}` : ''}`);
      return `**${who(e.author, e.agent)}** (${notes.join(', ')}):\n${e.body}`;
    }
    case 'status':
      return `_Status → ${e.status} (${who(e.by, e.agent)}, ${e.at})_`;
    case 'deleted':
      return `_Thread deleted: ${deletionLabel(e.reason)} (${e.at})_`;
  }
}

/** One thread's whole history, in markdown. */
export function renderThreadHistory(t: ThreadHistory, store: string): string {
  const a = t.anchor;
  const facts = [`Store: ${store}`];
  if (t.state === 'deleted') facts.push(`Deleted: ${deletionLabel(t.deletedReason)}`);
  if (t.archivedAt) facts.push(`Archived ${t.archivedAt}`);
  const branch = branchLabel(t.branch);
  if (branch) facts.push(`Branch: ${branch}`);
  const tag = versionTag(a);
  if (tag) facts.push(`About the ${tag === 'Index' ? 'staged version (index)' : `version ${tag}`}`);
  if (a.diff) facts.push(`Made in a diff (${a.diff.side === 'base' ? 'old' : 'new'} side)`);
  if (t.readOnly) facts.push('Written by a newer version of silykat: partly shown');
  const lines = [`### ${t.id} — ${where(t)} · ${t.state}`, '', facts.join(' · '), ''];
  if (a.range) lines.push(fence(a.snippet, a.path, a.range.startLine), '');
  for (const e of t.conversation) lines.push(renderEntry(e), '');
  return lines.join('\n').trimEnd();
}

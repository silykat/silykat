import { isAbsolute, relative } from 'node:path';
import type { HistoryEntry, ThreadHistory } from './history';
import type { ProjectHistory, StoreHistory } from './project';
import { LOOSE_ROOT } from './sessions';
import { topicLabel } from './topics';
import type { BranchRef } from './types';

/** A store as people read it: relative to the project folder when inside it. */
export function storeLabel(store: { root: string; saved?: { savedAt: string } }, root: string): string {
  if (store.root === LOOSE_ROOT) return '/ (files outside any open folder)';
  const rel = relative(root, store.root);
  const path = rel === '' ? '.' : rel.startsWith('..') || isAbsolute(rel) ? store.root : rel;
  return store.saved ? `${path} (saved ${store.saved.savedAt.slice(0, 10)})` : path;
}

const branchLabel = (b: BranchRef | null): string | null => (b ? topicLabel({ kind: 'branch', ...b }) : null);

const author = (by: string, agent?: string) => (by === 'user' ? 'user' : (agent ?? 'agent'));

function entryJson(e: HistoryEntry) {
  switch (e.kind) {
    case 'comment':
      return {
        type: 'comment',
        author: author(e.author, e.agent),
        body: e.body,
        at: e.at,
        ...(e.publishedAt ? { publishedAt: e.publishedAt } : {}),
        ...(e.editedAt ? { editedAt: e.editedAt } : {}),
        ...(e.deletedAt ? { deletedAt: e.deletedAt } : {}),
        ...(e.session ? { session: e.session } : {}),
      };
    case 'status':
      return { type: 'status', status: e.status, by: author(e.by, e.agent), at: e.at };
    case 'deleted':
      return { type: 'deleted', by: author(e.by, e.agent), at: e.at, reason: e.reason ?? null };
  }
}

const savedJson = (s: StoreHistory) =>
  s.saved && { worktree: s.saved.worktree, branch: s.saved.branch, savedAt: s.saved.savedAt, copy: s.saved.dir };

function threadJson(t: ThreadHistory, s: StoreHistory) {
  const a = t.anchor;
  return {
    id: t.id,
    store: s.root,
    state: t.state,
    status: t.status,
    branch: t.branch ? { name: t.branch.branch, repo: t.branch.repo, label: branchLabel(t.branch) } : null,
    path: a.path,
    source: a.source,
    ref: a.ref,
    sha: a.sha,
    ...(a.diff ? { diffSide: a.diff.side } : {}),
    range: a.range,
    code: a.snippet,
    createdAt: t.createdAt,
    lastActivityAt: t.lastActivityAt,
    deletedAt: t.deletedAt,
    deletedReason: t.deletedReason,
    archivedAt: t.archivedAt,
    resolvedAt: t.resolvedAt,
    ...(s.saved ? { savedFrom: savedJson(s) } : {}),
    ...(t.readOnly ? { readOnly: true } : {}),
    bytes: t.bytes,
    conversation: t.conversation.map(entryJson),
  };
}

/** The history of a project for tools: a summary, then every thread (oldest first, store by store). */
export function historyJson(h: ProjectHistory) {
  return {
    root: h.root,
    since: h.since,
    summary: {
      threads: h.threads,
      bytes: h.bytes,
      states: h.states,
      deletions: h.deletions,
      archived: h.archived,
      stores: h.stores.map((s) => ({
        root: s.root,
        label: storeLabel(s, h.root),
        origin: s.origin,
        threads: s.threads.length,
        bytes: s.bytes,
        states: s.states,
        deletions: s.deletions,
        archived: s.archived,
        ...(s.saved ? { savedFrom: savedJson(s) } : {}),
        ...(s.warnings.length > 0 ? { warnings: s.warnings } : {}),
      })),
    },
    threads: h.stores.flatMap((s) => s.threads.map((t) => threadJson(t, s))),
  };
}

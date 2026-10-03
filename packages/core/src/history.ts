import type { ThreadEvent } from './events';
import {
  DELETE_REASONS,
  type Anchor,
  type Author,
  type BranchRef,
  type DeleteReason,
  type ReviewState,
  type ThreadStatus,
} from './types';

/** Where a thread stands in its history: its status, or `deleted` whatever its status was. */
export type HistoryState = ThreadStatus | 'deleted';

export const HISTORY_STATES: readonly HistoryState[] = ['open', 'needs-info', 'addressed', 'resolved', 'deleted'];

/** One step of a thread's conversation, as published. */
export type HistoryEntry =
  | {
      kind: 'comment';
      id: string;
      author: Author;
      /** Display name of the agent, for agent comments. */
      agent?: string;
      /** The latest version of the text. */
      body: string;
      at: string;
      /** For a comment of a review: when the review was submitted (the comment was a draft until then). */
      publishedAt?: string;
      editedAt?: string;
      /** Deleted by its author: kept in the history, it still tells what was asked. */
      deletedAt?: string;
    }
  | { kind: 'status'; status: ThreadStatus; by: Author; agent?: string; at: string }
  /** `reason`: missing when the journal predates reasons and none can be told. */
  | { kind: 'deleted'; by: Author; agent?: string; at: string; reason?: DeleteReason };

/**
 * A thread's whole history, whatever its state: everything that was published in it, in order,
 * including the comments deleted since and the thread's deletion. Drafts of a review not submitted
 * (in progress or discarded) never belong to it: they are the user's until submitted.
 */
export interface ThreadHistory {
  id: string;
  state: HistoryState;
  /** The last status, kept for a deleted thread too. */
  status: ThreadStatus;
  /** Where the thread is now (its file and code, as last recorded). */
  anchor: Anchor;
  branch: BranchRef | null;
  createdAt: string;
  /** The last published change: a comment published, edited or deleted, a status, the deletion. */
  lastActivityAt: string;
  deletedAt: string | null;
  /**
   * Why it was deleted: removed by the user, or its branch was deleted. `null` when it is not deleted,
   * or when its journal predates reasons and none can be told.
   */
  deletedReason: DeleteReason | null;
  /** Written by a newer schema version: the events of that version are left out. */
  readOnly: boolean;
  conversation: HistoryEntry[];
  /** Size of the thread's journal, in bytes. */
  bytes: number;
}

export interface HistoryOptions {
  reviews?: ReadonlyMap<string, ReviewState>;
  futureVersion?: boolean;
  bytes?: number;
}

/**
 * Rebuilds a thread's history from its journal. `null` without `thread.created`, and for a thread
 * where nothing was ever published (only drafts).
 */
export function threadHistory(events: readonly ThreadEvent[], opts: HistoryOptions = {}): ThreadHistory | null {
  const first = events[0];
  if (!first || first.type !== 'thread.created') return null;
  const reviews = opts.reviews ?? new Map<string, ReviewState>();
  /** When a comment of `reviewId` was published; `null` while it is a draft (or was discarded). */
  const published = (reviewId: string | null, at: string): string | null => {
    if (reviewId === null) return at;
    const review = reviews.get(reviewId);
    return review?.state === 'submitted' ? (review.submittedAt ?? at) : null;
  };

  let anchor = first.anchor;
  let branch = first.branch ?? null;
  let status: ThreadStatus = 'open';
  let deletedAt: string | null = null;
  let deletedReason: DeleteReason | null = null;
  /** When the user last deleted a comment of the thread: a deletion in the same write removed its last one. */
  let lastCommentDeletedAt: string | null = null;
  const conversation: HistoryEntry[] = [];
  const comments = new Map<string, Extract<HistoryEntry, { kind: 'comment' }>>();
  /** When each comment became visible: at once, or when its review was submitted. */
  const publishedAt = new Map<string, string>();
  const drop = (id: string) => {
    comments.delete(id);
    const i = conversation.findIndex((x) => x.kind === 'comment' && x.id === id);
    if (i >= 0) conversation.splice(i, 1);
  };
  const agentOf = (e: ThreadEvent) => (e.by === 'agent' && e.agent ? { agent: e.agent } : {});

  for (const e of events.slice(1)) {
    switch (e.type) {
      case 'comment.added': {
        const at = published(e.reviewId, e.at);
        if (at === null) break;
        const c: Extract<HistoryEntry, { kind: 'comment' }> = {
          kind: 'comment',
          id: e.commentId,
          author: e.by,
          ...agentOf(e),
          body: e.body,
          at: e.at,
          ...(at !== e.at ? { publishedAt: at } : {}),
        };
        comments.set(c.id, c);
        publishedAt.set(c.id, at);
        conversation.push(c);
        break;
      }
      case 'comment.edited': {
        const c = comments.get(e.commentId);
        if (c && c.author === e.by && !c.deletedAt) {
          c.body = e.body;
          // Rewording a draft before submitting it is not an edit anyone saw.
          if (e.at >= publishedAt.get(c.id)!) c.editedAt = e.at;
        }
        break;
      }
      case 'comment.deleted': {
        const c = comments.get(e.commentId);
        if (!c || c.author !== e.by) break;
        // Deleted while still a draft: it was never published, so it never was in the conversation.
        if (e.at < publishedAt.get(c.id)!) drop(c.id);
        else c.deletedAt ??= e.at;
        lastCommentDeletedAt = e.at;
        break;
      }
      case 'status.changed':
        status = e.status;
        conversation.push({ kind: 'status', status: e.status, by: e.by, ...agentOf(e), at: e.at });
        break;
      case 'anchor.updated':
        anchor = e.anchor;
        break;
      case 'branch.changed':
        branch = e.branch;
        break;
      case 'thread.deleted':
        if (deletedAt === null) {
          deletedAt = e.at;
          // Older journals have no reason; deleting the last comment (same write) was the user's choice.
          // A reason this version does not know (written by a newer one) reads as unknown.
          deletedReason = knownReason(e.reason) ?? (lastCommentDeletedAt === e.at ? 'user' : null);
          conversation.push({
            kind: 'deleted',
            by: e.by,
            ...agentOf(e),
            at: e.at,
            ...(deletedReason ? { reason: deletedReason } : {}),
          });
        }
        break;
      case 'thread.created':
        break; // a second creation event is invalid
    }
  }

  // Drafts of a review submitted after the thread was deleted were never published.
  if (deletedAt !== null) for (const [id, at] of publishedAt) if (at > deletedAt && comments.has(id)) drop(id);
  if (comments.size === 0) return null;
  // Every comment deleted by its author: the thread is gone too (older journals may lack the event).
  const all = [...comments.values()];
  if (deletedAt === null && all.every((c) => c.deletedAt)) {
    deletedAt = all
      .map((c) => c.deletedAt!)
      .sort()
      .at(-1)!;
    deletedReason = 'user';
  }

  const activity = conversation.flatMap((x) =>
    x.kind === 'comment' ? [x.publishedAt ?? x.at, x.editedAt ?? '', x.deletedAt ?? ''] : [x.at],
  );
  if (deletedAt) activity.push(deletedAt);
  return {
    id: first.threadId,
    state: deletedAt ? 'deleted' : status,
    status,
    anchor,
    branch,
    createdAt: first.at,
    lastActivityAt: activity.reduce((a, b) => (b > a ? b : a), first.at),
    deletedAt,
    deletedReason: deletedAt ? deletedReason : null,
    readOnly: opts.futureVersion ?? false,
    conversation,
    bytes: opts.bytes ?? 0,
  };
}

/** Whether a thread had published activity at or after `sinceMs` (any thread when `null`). */
export function activeSince(thread: ThreadHistory, sinceMs: number | null): boolean {
  return sinceMs === null || Date.parse(thread.lastActivityAt) >= sinceMs;
}

export type StateCounts = Record<HistoryState, number>;

/** How many threads are in each state. */
export function countStates(threads: readonly ThreadHistory[]): StateCounts {
  const counts = Object.fromEntries(HISTORY_STATES.map((s) => [s, 0])) as StateCounts;
  for (const t of threads) counts[t.state]++;
  return counts;
}

const knownReason = (r: unknown): DeleteReason | null =>
  DELETE_REASONS.includes(r as DeleteReason) ? (r as DeleteReason) : null;

/** Deleted threads by reason (`unknown`: older journals, which do not tell). */
export type DeletionCounts = Record<DeleteReason | 'unknown', number>;

export function countDeletions(threads: readonly ThreadHistory[]): DeletionCounts {
  const counts: DeletionCounts = { user: 0, 'branch-gone': 0, unknown: 0 };
  for (const t of threads) if (t.state === 'deleted') counts[t.deletedReason ?? 'unknown']++;
  return counts;
}

/** How a deletion reads for people. */
export function deletionLabel(reason: DeleteReason | null | undefined): string {
  return reason === 'user'
    ? 'removed by the user'
    : reason === 'branch-gone'
      ? 'its branch was deleted'
      : 'reason unknown';
}

import type { ThreadEvent } from './events';
import type { CommentState, ReviewState, ThreadState } from './types';

export interface FoldOptions {
  reviews?: ReadonlyMap<string, ReviewState>;
  futureVersion?: boolean;
}

/** Rebuilds a thread's state from its journal. Returns `null` if the journal has no `thread.created`. */
export function foldThread(events: readonly ThreadEvent[], opts: FoldOptions = {}): ThreadState | null {
  const first = events[0];
  if (!first || first.type !== 'thread.created') return null;

  const reviews = opts.reviews ?? new Map<string, ReviewState>();
  const isDraft = (reviewId: string | null): boolean =>
    reviewId !== null && reviews.get(reviewId)?.state !== 'submitted';

  const state: ThreadState = {
    id: first.threadId,
    anchor: first.anchor,
    status: 'open',
    comments: [],
    createdAt: first.at,
    deleted: false,
    readOnly: opts.futureVersion ?? false,
    lastAuthor: null,
    lastAgentName: null,
    hasPublished: false,
    onlyDrafts: false,
  };
  const byId = new Map<string, CommentState>();
  const discarded = (reviewId: string | null): boolean =>
    reviewId !== null && reviews.get(reviewId)?.state === 'discarded';

  for (const e of events.slice(1)) {
    switch (e.type) {
      case 'comment.added': {
        if (discarded(e.reviewId)) break;
        const c: CommentState = {
          id: e.commentId,
          author: e.by,
          ...(e.by === 'agent' && e.agent ? { agentName: e.agent } : {}),
          body: e.body,
          createdAt: e.at,
          reviewId: e.reviewId,
          isDraft: isDraft(e.reviewId),
        };
        byId.set(c.id, c);
        state.comments.push(c);
        break;
      }
      case 'comment.edited': {
        const c = byId.get(e.commentId);
        if (c && c.author === e.by) {
          c.body = e.body;
          c.editedAt = e.at;
        }
        break;
      }
      case 'comment.deleted': {
        const c = byId.get(e.commentId);
        if (c && c.author === e.by) {
          byId.delete(e.commentId);
          state.comments = state.comments.filter((x) => x.id !== e.commentId);
        }
        break;
      }
      case 'status.changed':
        state.status = e.status;
        break;
      case 'anchor.updated':
        state.anchor = e.anchor;
        break;
      case 'thread.deleted':
        state.deleted = true;
        break;
      case 'thread.created':
        // A second creation event is invalid; ignore it.
        break;
    }
  }

  const last = state.comments[state.comments.length - 1];
  state.lastAuthor = last ? last.author : null;
  state.lastAgentName = [...state.comments].reverse().find((c) => c.agentName)?.agentName ?? null;
  state.hasPublished = state.comments.some((c) => !c.isDraft);
  state.onlyDrafts = state.comments.length > 0 && !state.hasPublished;
  return state;
}

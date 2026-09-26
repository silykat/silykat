import type { CommentState, ThreadState } from '@local-review/core';

// Pure so that the manifest's `when` clauses can be unit-tested against it.

/**
 * Context value of a thread, matched by `commentThread =~ /…/` in the manifest.
 * Shape: `lr <status>`, or `lr readonly <status>` so that write actions never match read-only threads.
 */
export function threadContextValue(state: Pick<ThreadState, 'status' | 'readOnly'>): string {
  return state.readOnly ? `lr readonly ${state.status}` : `lr ${state.status}`;
}

/** Context value of a comment, matched by `comment == …`: only the user's comments get edit/delete. */
export function commentContextValue(comment: Pick<CommentState, 'author'>): string {
  return `author-${comment.author}`;
}

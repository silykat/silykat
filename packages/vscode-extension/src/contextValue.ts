import type { CommentState, ThreadState } from '@local-review/core';

// Pure so that the manifest's `when` clauses can be unit-tested against it.

/**
 * Context value of a thread, matched by `commentThread =~ /…/` in the manifest. Shapes:
 * - `lr <status>`: a published thread;
 * - `lr draft <status>`: a thread that only holds draft comments (review in progress);
 * - `lr readonly <status>`: written by a newer version, so no write action ever matches it;
 * - any of them followed by ` diff` when the thread was made in a diff (it can reopen it).
 */
export function threadContextValue(
  state: Pick<ThreadState, 'status' | 'readOnly' | 'onlyDrafts'> & { anchor?: Pick<ThreadState['anchor'], 'diff'> },
): string {
  const kind = state.readOnly ? 'readonly ' : state.onlyDrafts ? 'draft ' : '';
  return `lr ${kind}${state.status}${state.anchor?.diff ? ' diff' : ''}`;
}

/** Context value of a comment, matched by `comment == …`: only the user's comments get edit/delete. */
export function commentContextValue(comment: Pick<CommentState, 'author'>): string {
  return `author-${comment.author}`;
}

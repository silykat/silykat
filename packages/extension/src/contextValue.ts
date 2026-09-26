import type { ThreadState } from '@local-review/core';

// Pure so that the manifest's `when` clauses can be unit-tested against it.

/**
 * Context value of a thread, matched by `commentThread =~ /…/` in the manifest.
 * Shape: `lr <status>`, or `lr readonly <status>` so that write actions never match read-only threads.
 */
export function threadContextValue(state: Pick<ThreadState, 'status' | 'readOnly'>): string {
  return state.readOnly ? `lr readonly ${state.status}` : `lr ${state.status}`;
}

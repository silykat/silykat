import type { ThreadState } from '@local-review/core';
import { versionTag } from './gitUri';

// Pure (no `vscode` import) so that labels can be unit-tested.

/** Name shown for the agent until the user plugs in and names their own. */
export const DEFAULT_AGENT_NAME = 'Claude';

/** Status label shown in the thread header; `undefined` for resolved threads. */
export function threadLabel(state: ThreadState, outdated = false): string | undefined {
  // Nobody but the user sees a draft-only thread yet: its status means nothing so far.
  const status = state.onlyDrafts ? 'Pending' : statusLabel(state);
  // A thread on an older version (a side of a diff) says which one: "Index", "HEAD a92bf1e"…
  const parts = [outdated ? '⚠️ Outdated' : undefined, versionTag(state.anchor), status].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * Rendering-only prefix of an outdated thread's first comment: the code it was about,
 * since that code is no longer in the file (like GitHub's outdated comments).
 */
export function outdatedQuote(snippet: string): string {
  // A fence longer than any backtick run in the snippet, so the snippet cannot close it.
  const longestRun = Math.max(0, ...(snippet.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `*This code is no longer in the file:*\n\n${fence}\n${snippet}\n${fence}\n\n---\n\n`;
}

function statusLabel(state: ThreadState): string | undefined {
  const agent = state.lastAgentName ?? DEFAULT_AGENT_NAME;
  switch (state.status) {
    case 'resolved':
      return undefined;
    case 'needs-info':
      return `❓ ${agent} is waiting for your reply`;
    case 'addressed':
      return `✅ Addressed by ${agent} — please verify`;
    case 'open':
      return state.lastAuthor === 'agent' ? `💬 ${agent} replied` : `Waiting for ${agent}`;
  }
}

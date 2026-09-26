import type { ThreadState } from '@local-review/core';

// Pure (no `vscode` import) so that labels can be unit-tested.

/** Name shown for the agent until the user plugs in and names their own (D22, D23). */
export const DEFAULT_AGENT_NAME = 'Claude';

/** Status label shown in the thread header; `undefined` for resolved threads. */
export function threadLabel(state: ThreadState, outdated = false): string | undefined {
  const status = statusLabel(state);
  if (!outdated) return status;
  return status ? `⚠️ Outdated · ${status}` : '⚠️ Outdated';
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


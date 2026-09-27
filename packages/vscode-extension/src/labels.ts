import type { CommentState, ThreadState } from '@local-review/core';
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

/**
 * When the user edited a comment after an agent had replied to it (that reply was about the old
 * version): that agent's name. `undefined` otherwise.
 */
export function editedAfterAgentReplied(comments: readonly CommentState[], c: CommentState): string | undefined {
  if (c.author !== 'user' || !c.editedAt) return undefined;
  const edited = c.editedAt;
  const reply = comments.find((o) => o.author === 'agent' && o.createdAt > c.createdAt && o.createdAt < edited);
  return reply ? (reply.agentName ?? DEFAULT_AGENT_NAME) : undefined;
}

/** The next move is the agent's: the user spoke last, or edited a comment after the agent's last reply. */
function agentsTurn(state: ThreadState): boolean {
  if (state.lastAuthor !== 'agent') return true;
  const lastAgentAt = [...state.comments].reverse().find((c) => c.author === 'agent')?.createdAt ?? '';
  return state.comments.some((c) => c.author === 'user' && c.editedAt !== undefined && c.editedAt > lastAgentAt);
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
      return agentsTurn(state) ? `Waiting for ${agent}` : `💬 ${agent} replied`;
  }
}

import * as vscode from 'vscode';
import type { CommentState, ThreadState } from '@local-review/core';
import { toZeroBasedLines } from './range';

export interface RenderContext {
  userName: string;
  claudeIcon: vscode.Uri;
}

/** Comment bodies come from the user or from Claude: always render them as untrusted markdown. */
function untrustedMarkdown(body: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString(body);
  md.isTrusted = false;
  md.supportHtml = false;
  md.supportThemeIcons = false;
  return md;
}

function toVsComment(c: CommentState, ctx: RenderContext): vscode.Comment {
  return {
    body: untrustedMarkdown(c.body),
    mode: vscode.CommentMode.Preview,
    author: c.author === 'user' ? { name: ctx.userName } : { name: 'Claude', iconPath: ctx.claudeIcon },
    timestamp: new Date(c.createdAt),
    contextValue: `author-${c.author}`,
  };
}

/** Status label shown in the thread header; `undefined` for resolved threads. */
export function threadLabel(state: ThreadState): string | undefined {
  switch (state.status) {
    case 'resolved':
      return undefined;
    case 'needs-info':
      return '❓ Claude is waiting for your reply';
    case 'addressed':
      return '✅ Addressed by Claude — please verify';
    case 'open':
      return state.lastAuthor === 'claude' ? '💬 Claude replied' : 'Waiting for Claude';
  }
}

/** Threads where the next move is the user's. */
export function awaitsUser(state: ThreadState): boolean {
  return state.status === 'needs-info' || state.status === 'addressed';
}

export function threadRange(state: ThreadState): vscode.Range | undefined {
  if (!state.anchor.range) return undefined;
  const { start, end } = toZeroBasedLines(state.anchor.range);
  return new vscode.Range(start, 0, end, 0);
}

/**
 * Idempotent: brings a VS Code thread in line with the stored state.
 * Never touches `collapsibleState`: expanding is the caller's decision, so a thread the
 * user opened or closed stays that way.
 */
export function applyThreadState(thread: vscode.CommentThread, state: ThreadState, ctx: RenderContext): void {
  thread.comments = state.comments.map((c) => toVsComment(c, ctx));
  thread.label = threadLabel(state);
  thread.contextValue = ['lr', state.status, state.readOnly ? 'readonly' : ''].filter(Boolean).join(' ');
  // Replies arrive with US-03.
  thread.canReply = false;
  thread.state =
    state.status === 'resolved' ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
}

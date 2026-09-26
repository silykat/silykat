import * as vscode from 'vscode';
import type { CommentState, ThreadState } from '@local-review/core';
import { toZeroBasedLines } from './range';

export interface RenderContext {
  userName: string;
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
    author: { name: c.author === 'user' ? ctx.userName : 'Claude' },
    timestamp: new Date(c.createdAt),
    contextValue: `author-${c.author}`,
  };
}

export function threadRange(state: ThreadState): vscode.Range | undefined {
  if (!state.anchor.range) return undefined;
  const { start, end } = toZeroBasedLines(state.anchor.range);
  return new vscode.Range(start, 0, end, 0);
}

/** Idempotent: brings a VS Code thread in line with the stored state. */
export function applyThreadState(thread: vscode.CommentThread, state: ThreadState, ctx: RenderContext): void {
  thread.comments = state.comments.map((c) => toVsComment(c, ctx));
  thread.contextValue = ['lr', state.status, state.readOnly ? 'readonly' : ''].filter(Boolean).join(' ');
  // Replies arrive with US-03.
  thread.canReply = false;
  thread.state =
    state.status === 'resolved' ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
}

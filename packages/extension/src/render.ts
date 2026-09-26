import * as vscode from 'vscode';
import type { CommentState, ThreadState } from '@local-review/core';
import { commentContextValue, threadContextValue } from './contextValue';
import { toZeroBasedLines } from './range';

/** Name shown for the agent until the user plugs in and names their own (D22, D23). */
export const DEFAULT_AGENT_NAME = 'Claude';

export interface RenderContext {
  userName: string;
  agentIcon: vscode.Uri;
}

/** Comment bodies come from the user or from an agent: always render them as untrusted markdown. */
function untrustedMarkdown(body: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString(body);
  md.isTrusted = false;
  md.supportHtml = false;
  md.supportThemeIcons = false;
  return md;
}

/** Plain text of a comment body; VS Code puts the edited text back as a string. */
export function bodyText(body: string | vscode.MarkdownString): string {
  return typeof body === 'string' ? body : body.value;
}

/** A rendered comment that knows which stored comment it shows. */
export class LrComment implements vscode.Comment {
  body: string | vscode.MarkdownString;
  mode = vscode.CommentMode.Preview;
  readonly author: vscode.CommentAuthorInformation;
  readonly timestamp: Date;
  readonly contextValue: string;
  readonly label: string | undefined;
  readonly commentId: string;
  readonly isUserComment: boolean;
  /** Stored text, restored when an edit is cancelled. */
  readonly savedBody: string;

  constructor(
    readonly threadId: string,
    c: CommentState,
    ctx: RenderContext,
  ) {
    this.commentId = c.id;
    this.isUserComment = c.author === 'user';
    this.savedBody = c.body;
    this.body = untrustedMarkdown(c.body);
    this.author =
      c.author === 'user' ? { name: ctx.userName } : { name: c.agentName ?? DEFAULT_AGENT_NAME, iconPath: ctx.agentIcon };
    this.timestamp = new Date(c.createdAt);
    this.contextValue = commentContextValue(c);
    this.label = c.editedAt ? 'edited' : undefined;
  }

  restore(): void {
    this.body = untrustedMarkdown(this.savedBody);
    this.mode = vscode.CommentMode.Preview;
  }
}

/** Status label shown in the thread header; `undefined` for resolved threads. */
export function threadLabel(state: ThreadState): string | undefined {
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
 * user opened or closed stays that way. A comment being edited is kept as is, so that a
 * refresh (e.g. the agent replying meanwhile) never throws away the user's unsaved edit.
 */
export function applyThreadState(thread: vscode.CommentThread, state: ThreadState, ctx: RenderContext): void {
  const editing = new Map(
    thread.comments
      .filter((c): c is LrComment => c instanceof LrComment && c.mode === vscode.CommentMode.Editing)
      .map((c) => [c.commentId, c]),
  );
  thread.comments = state.comments.map((c) => editing.get(c.id) ?? new LrComment(state.id, c, ctx));
  thread.label = threadLabel(state);
  thread.contextValue = threadContextValue(state);
  thread.canReply = state.readOnly ? false : { name: ctx.userName };
  thread.state =
    state.status === 'resolved' ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
}

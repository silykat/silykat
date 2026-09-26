import * as vscode from 'vscode';
import type { CommentState, ThreadState } from '@local-review/core';
import { commentContextValue, threadContextValue } from './contextValue';
import { DEFAULT_AGENT_NAME, outdatedQuote, threadLabel } from './labels';
import { toZeroBasedLines } from './range';

export { DEFAULT_AGENT_NAME } from './labels';

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
  /** Stored text: what an edit starts from. */
  readonly savedBody: string;
  /** What is displayed: the stored text, possibly after a rendering-only prefix. */
  private readonly displayBody: string;

  constructor(
    readonly threadId: string,
    c: CommentState,
    ctx: RenderContext,
    prefix = '',
  ) {
    this.commentId = c.id;
    this.isUserComment = c.author === 'user';
    this.savedBody = c.body;
    this.displayBody = prefix + c.body;
    this.body = untrustedMarkdown(this.displayBody);
    this.author =
      c.author === 'user'
        ? { name: ctx.userName }
        : { name: c.agentName ?? DEFAULT_AGENT_NAME, iconPath: ctx.agentIcon };
    this.timestamp = new Date(c.createdAt);
    this.contextValue = commentContextValue(c);
    this.label = [c.isDraft ? 'Pending' : '', c.editedAt ? 'edited' : ''].filter(Boolean).join(' · ') || undefined;
  }

  /** Switches to the inline editor, on the stored text only (never the rendering prefix). */
  startEditing(): void {
    this.body = this.savedBody;
    this.mode = vscode.CommentMode.Editing;
  }

  restore(): void {
    this.body = untrustedMarkdown(this.displayBody);
    this.mode = vscode.CommentMode.Preview;
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
export function applyThreadState(
  thread: vscode.CommentThread,
  state: ThreadState,
  ctx: RenderContext,
  opts: { outdated?: boolean } = {},
): void {
  const editing = new Map(
    thread.comments
      .filter((c): c is LrComment => c instanceof LrComment && c.mode === vscode.CommentMode.Editing)
      .map((c) => [c.commentId, c]),
  );
  const quote = opts.outdated ? outdatedQuote(state.anchor.snippet) : '';
  thread.comments = state.comments.map(
    (c, i) => editing.get(c.id) ?? new LrComment(state.id, c, ctx, i === 0 ? quote : ''),
  );
  thread.label = threadLabel(state, opts.outdated);
  thread.contextValue = threadContextValue(state);
  thread.canReply = state.readOnly ? false : { name: ctx.userName };
  thread.state =
    state.status === 'resolved' ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
}

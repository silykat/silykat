import { userInfo } from 'node:os';
import * as vscode from 'vscode';
import { buildAnchorContext, type Anchor, type ThreadState } from '@local-review/core';
import { ensureExcluded, gitUserName } from './git';
import type { Log } from './log';
import { toLineRange } from './range';
import { applyThreadState, awaitsUser, bodyText, LrComment, threadRange, type RenderContext } from './render';
import { Roots, type Root } from './roots';
import { watchThreads } from './watcher';

export const CONTROLLER_ID = 'local-review';

/** Asks the user to confirm a destructive action. Replaceable in tests. */
export type ConfirmHandler = (message: string, detail: string, action: string) => Promise<boolean>;

const modalConfirm: ConfirmHandler = async (message, detail, action) =>
  (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action;

interface Managed {
  state: ThreadState;
  root: Root;
  thread: vscode.CommentThread;
}

/** Owns the comment controller and keeps VS Code threads in sync with the stores. */
export class ReviewController implements vscode.Disposable {
  readonly controller: vscode.CommentController;
  private readonly roots = new Roots();
  private readonly managed = new Map<string, Managed>();
  private readonly byThread = new WeakMap<vscode.CommentThread, string>();
  private readonly excludedRoots = new Set<string>();
  private watchers: vscode.Disposable[] = [];
  confirm: ConfirmHandler = modalConfirm;
  private ctx: RenderContext;

  constructor(
    private readonly log: Log,
    extensionUri: vscode.Uri,
  ) {
    this.ctx = { userName: 'Me', agentIcon: vscode.Uri.joinPath(extensionUri, 'media', 'agent.svg') };
    this.controller = vscode.comments.createCommentController(CONTROLLER_ID, 'Local Review');
    this.controller.options = {
      prompt: 'Reply',
      placeHolder: 'Write a comment (Markdown supported)…',
    };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (doc) => this.commentingRanges(doc),
    };
  }

  /** (Re)discovers roots and re-renders every stored thread. */
  async reload(): Promise<void> {
    for (const m of this.managed.values()) m.thread.dispose();
    this.managed.clear();
    this.disposeWatchers();

    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
    await this.roots.init(folders.map((f) => f.uri.fsPath));
    this.ctx = { ...this.ctx, userName: await this.resolveUserName() };

    for (const root of this.roots.all()) {
      this.watchers.push(watchThreads(root.path, (threadId) => void this.refreshThread(root, threadId)));
      try {
        const { threads, warnings } = await root.store.loadAll();
        warnings.forEach((w) => this.log.warn(`${root.path}: ${w}`));
        threads.forEach((state) => this.render(root, state));
        this.log.info(`${root.path}: ${threads.length} thread(s) loaded`);
      } catch (err) {
        this.log.error(`${root.path}: failed to load threads`, err);
      }
    }
  }

  /** Handler of the "Comment" button under a new thread's input. */
  async submitNewComment(reply: vscode.CommentReply): Promise<void> {
    const { thread } = reply;
    const text = reply.text.trim();
    if (text === '' || this.byThread.has(thread)) return;

    const root = this.roots.forFile(thread.uri.fsPath);
    if (thread.uri.scheme !== 'file' || !root) {
      void vscode.window.showErrorMessage('Local Review: this file is not part of any workspace folder.');
      return;
    }
    if (!thread.range) {
      void vscode.window.showWarningMessage('Local Review: file-level comments are not supported yet.');
      return;
    }

    try {
      const doc = await vscode.workspace.openTextDocument(thread.uri);
      const anchor: Anchor = {
        path: Roots.anchorPath(root, thread.uri.fsPath),
        source: 'worktree',
        ref: null,
        sha: null,
        ...buildAnchorContext(doc.getText(), toLineRange(thread.range.start, thread.range.end)),
      };
      const state = await root.store.createThread(anchor, { author: 'user', body: text, reviewId: null });
      this.adopt(root, state, thread);
      await this.excludeFromGit(root);
    } catch (err) {
      this.log.error('Failed to save the comment', err);
      void vscode.window.showErrorMessage(`Local Review: the comment could not be saved (${String(err)}).`);
    }
  }

  /** Handler of the "Reply" button under an existing thread. */
  async reply(reply: vscode.CommentReply): Promise<void> {
    const text = reply.text.trim();
    const threadId = this.byThread.get(reply.thread);
    const managed = threadId ? this.managed.get(threadId) : undefined;
    if (text === '' || !threadId || !managed) return;

    try {
      const state = await managed.root.store.addComment(threadId, { author: 'user', body: text, reviewId: null });
      this.adopt(managed.root, state, reply.thread);
    } catch (err) {
      this.log.error('Failed to save the reply', err);
      void vscode.window.showErrorMessage(`Local Review: the reply could not be saved (${String(err)}).`);
    }
  }

  /** "Resolve" / "Reopen" from the thread header. Only the user resolves (D06). */
  async setThreadStatus(thread: vscode.CommentThread, status: 'resolved' | 'open'): Promise<void> {
    const threadId = this.byThread.get(thread);
    const managed = threadId ? this.managed.get(threadId) : undefined;
    if (!threadId || !managed) return;

    try {
      const state = await managed.root.store.setStatus(threadId, status, 'user');
      this.adopt(managed.root, state, thread);
      thread.collapsibleState =
        status === 'resolved'
          ? vscode.CommentThreadCollapsibleState.Collapsed
          : vscode.CommentThreadCollapsibleState.Expanded;
    } catch (err) {
      this.log.error(`Failed to set thread status to ${status}`, err);
      void vscode.window.showErrorMessage(`Local Review: the thread could not be updated (${String(err)}).`);
    }
  }

  /** "Edit" on one of the user's comments: switches it to an inline editor. */
  editComment(comment: LrComment): void {
    const managed = this.managed.get(comment.threadId);
    if (!managed || !comment.isUserComment || managed.state.readOnly) return;
    comment.mode = vscode.CommentMode.Editing;
    managed.thread.comments = [...managed.thread.comments];
  }

  /** "Save" under a comment being edited. VS Code has put the edited text in `comment.body`. */
  async saveEdit(comment: LrComment): Promise<void> {
    const managed = this.managed.get(comment.threadId);
    if (!managed || !comment.isUserComment) return;
    const text = bodyText(comment.body).trim();
    if (text === '') {
      void vscode.window.showWarningMessage('Local Review: a comment cannot be empty. Delete it instead.');
      return;
    }
    try {
      comment.mode = vscode.CommentMode.Preview; // leave edit mode so the refresh re-renders it
      const state = await managed.root.store.editComment(comment.threadId, comment.commentId, text, 'user');
      this.adopt(managed.root, state, managed.thread);
    } catch (err) {
      comment.mode = vscode.CommentMode.Editing;
      managed.thread.comments = [...managed.thread.comments];
      this.log.error('Failed to save the edit', err);
      void vscode.window.showErrorMessage(`Local Review: the edit could not be saved (${String(err)}).`);
    }
  }

  cancelEdit(comment: LrComment): void {
    const managed = this.managed.get(comment.threadId);
    if (!managed) return;
    comment.restore();
    managed.thread.comments = [...managed.thread.comments];
  }

  /** "Delete" on one of the user's comments. The last comment takes the thread with it. */
  async deleteComment(comment: LrComment): Promise<void> {
    const managed = this.managed.get(comment.threadId);
    if (!managed || !comment.isUserComment || managed.state.readOnly) return;
    const isLast = managed.state.comments.length === 1;
    const confirmed = await this.confirm(
      'Delete this comment?',
      isLast ? 'It is the only comment of the thread: the thread will be deleted too.' : 'It will no longer be shown.',
      'Delete',
    );
    if (!confirmed) return;
    try {
      const state = await managed.root.store.deleteComment(comment.threadId, comment.commentId, 'user');
      if (state.deleted) this.forget(state.id);
      else this.adopt(managed.root, state, managed.thread);
    } catch (err) {
      this.log.error('Failed to delete the comment', err);
      void vscode.window.showErrorMessage(`Local Review: the comment could not be deleted (${String(err)}).`);
    }
  }

  /** "Delete Thread" in the thread header: the whole conversation, agent replies included. */
  async deleteThread(thread: vscode.CommentThread): Promise<void> {
    const threadId = this.byThread.get(thread);
    const managed = threadId ? this.managed.get(threadId) : undefined;
    if (!threadId || !managed || managed.state.readOnly) return;
    const n = managed.state.comments.length;
    const confirmed = await this.confirm(
      'Delete this thread?',
      `Its ${n} comment${n > 1 ? 's' : ''}, including the agent's replies, will no longer be shown.`,
      'Delete Thread',
    );
    if (!confirmed) return;
    try {
      await managed.root.store.deleteThread(threadId, 'user');
      this.forget(threadId);
    } catch (err) {
      this.log.error('Failed to delete the thread', err);
      void vscode.window.showErrorMessage(`Local Review: the thread could not be deleted (${String(err)}).`);
    }
  }

  /** Re-reads one journal after it changed on disk, whoever wrote it. */
  async refreshThread(root: Root, threadId: string): Promise<void> {
    let state: ThreadState | null;
    try {
      const loaded = await root.store.loadThread(threadId);
      loaded.warnings.forEach((w) => this.log.warn(`${root.path}: ${w}`));
      state = loaded.state;
    } catch (err) {
      this.log.error(`${root.path}: failed to reload thread ${threadId}`, err);
      return;
    }

    const existing = this.managed.get(threadId);
    if (!state || state.deleted) {
      this.forget(threadId);
      return;
    }
    if (!existing) {
      this.render(root, state);
      return;
    }

    const turnedToUser = awaitsUser(state) && (!awaitsUser(existing.state) || state.comments.length > existing.state.comments.length);
    this.adopt(root, state, existing.thread);
    // Bring the thread to the user's attention when the agent hands the ball back.
    if (turnedToUser) existing.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  }

  cancelNewThread(reply: vscode.CommentReply | vscode.CommentThread): void {
    const thread = 'thread' in reply ? reply.thread : reply;
    if (!this.byThread.has(thread)) thread.dispose();
  }

  /** Snapshot for tests and diagnostics. */
  listThreads(): { id: string; rootPath: string; state: ThreadState; thread: vscode.CommentThread }[] {
    return [...this.managed.entries()].map(([id, m]) => ({ id, rootPath: m.root.path, state: m.state, thread: m.thread }));
  }

  dispose(): void {
    this.disposeWatchers();
    this.controller.dispose();
  }

  private forget(threadId: string): void {
    this.managed.get(threadId)?.thread.dispose();
    this.managed.delete(threadId);
  }

  private disposeWatchers(): void {
    this.watchers.forEach((w) => w.dispose());
    this.watchers = [];
  }

  private commentingRanges(doc: vscode.TextDocument): vscode.Range[] {
    if (doc.uri.scheme !== 'file' || !this.roots.isCommentable(doc.uri.fsPath)) return [];
    return [new vscode.Range(0, 0, Math.max(0, doc.lineCount - 1), 0)];
  }

  private render(root: Root, state: ThreadState): void {
    const uri = vscode.Uri.joinPath(vscode.Uri.file(root.path), ...state.anchor.path.split('/'));
    const range = threadRange(state) ?? new vscode.Range(0, 0, 0, 0);
    const thread = this.controller.createCommentThread(uri, range, []);
    thread.collapsibleState =
      state.status === 'resolved'
        ? vscode.CommentThreadCollapsibleState.Collapsed
        : vscode.CommentThreadCollapsibleState.Expanded;
    this.adopt(root, state, thread);
  }

  private adopt(root: Root, state: ThreadState, thread: vscode.CommentThread): void {
    // The watcher may have rendered this thread before its creator adopted it: keep a single instance.
    const previous = this.managed.get(state.id);
    if (previous && previous.thread !== thread) previous.thread.dispose();
    const range = threadRange(state);
    if (range) thread.range = range;
    applyThreadState(thread, state, this.ctx);
    this.managed.set(state.id, { state, root, thread });
    this.byThread.set(thread, state.id);
  }

  private async excludeFromGit(root: Root): Promise<void> {
    if (!root.isGit || this.excludedRoots.has(root.path)) return;
    if (!vscode.workspace.getConfiguration('localReview').get<boolean>('excludeFromGit', true)) return;
    try {
      if (await ensureExcluded(root.path)) this.log.info(`${root.path}: added .local-review/ to .git/info/exclude`);
      this.excludedRoots.add(root.path);
    } catch (err) {
      this.log.warn(`${root.path}: could not update .git/info/exclude`, err);
    }
  }

  private async resolveUserName(): Promise<string> {
    const configured = vscode.workspace.getConfiguration('localReview').get<string>('userName', '').trim();
    if (configured) return configured;
    const first = this.roots.all()[0];
    const fromGit = first ? await gitUserName(first.path) : null;
    if (fromGit) return fromGit;
    try {
      return userInfo().username;
    } catch {
      return 'Me';
    }
  }
}

import { access, readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { basename, isAbsolute, join, sep } from 'node:path';
import * as vscode from 'vscode';
import {
  buildAnchorContext,
  reanchor,
  type Anchor,
  type AnchorSide,
  type DiffInfo,
  type LineRange,
  type ReviewState,
  type ThreadState,
} from '@local-review/core';
import { commitExists, ensureExcluded, findRename, gitUserName, resolveCommit } from './git';
import { anchorRef, isIndexRef, parseGitQuery, versionTag } from './gitUri';
import type { Log } from './log';
import { toLineRange, toZeroBasedLines } from './range';
import {
  applyThreadState,
  awaitsUser,
  bodyText,
  DEFAULT_AGENT_NAME,
  LrComment,
  threadRange,
  type RenderContext,
} from './render';
import { Roots, type Root } from './roots';
import { applyChanges, REMOVED } from './tracking';
import { watchStore } from './watcher';

export const CONTROLLER_ID = 'local-review';

/** Delay after a document change before trusting its dirty flag. */
const SETTLE_MS = 300;

/** Asks the user to confirm a destructive action. Replaceable in tests. */
export type ConfirmHandler = (message: string, detail: string, action: string) => Promise<boolean>;

const modalConfirm: ConfirmHandler = async (message, detail, action) =>
  (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action;

/** Asks the user to pick one of a few actions (or none). Replaceable in tests. */
export type ChooseHandler = (message: string, actions: string[]) => Promise<string | undefined>;

const warningChoice: ChooseHandler = (message, actions) =>
  Promise.resolve(vscode.window.showWarningMessage(message, ...actions));

interface Managed {
  state: ThreadState;
  root: Root;
  /** The canonical instance: on the file, or on the exact git version the thread is about. */
  thread: vscode.CommentThread;
}

/** A reply from the agent that arrived while VS Code was running. */
/** Comments the user made visible to the agent: to hand over to its session. */
export interface Publication {
  root: string;
  kind: 'comment' | 'reply' | 'review';
  threadIds: string[];
  reviewId?: string;
}

export interface AgentReply {
  threadId: string;
  agentName: string;
  path: string;
  /** 1-based first line of the thread, `null` for outdated or file-level threads. */
  line: number | null;
}

/** Where a new thread's anchor points, before its lines are known. */
type AnchorBase = Pick<Anchor, 'path' | 'source' | 'ref' | 'sha' | 'diff'>;

/** URI of a version of a file as the built-in git extension builds it (query = {path, ref}). */
function gitUri(fsPath: string, ref: string): vscode.Uri {
  return vscode.Uri.file(fsPath).with({ scheme: 'git', query: JSON.stringify({ path: fsPath, ref }) });
}

/** Owns the comment controller and keeps VS Code threads in sync with the stores. */
export class ReviewController implements vscode.Disposable {
  readonly controller: vscode.CommentController;
  private readonly roots = new Roots();
  private readonly managed = new Map<string, Managed>();
  private readonly byThread = new WeakMap<vscode.CommentThread, string>();
  private readonly excludedRoots = new Set<string>();
  /** Positions of threads in documents with unsaved edits; persisted on save. */
  private readonly liveRanges = new Map<string, LineRange>();
  private readonly settleTimers = new Map<string, NodeJS.Timeout>();
  /** Threads whose code is no longer in the file. Derived state: never written. */
  private readonly outdated = new Set<string>();
  /** The review in progress in each root, by root path. */
  private readonly activeReviews = new Map<string, ReviewState>();
  /**
   * Extra instances of git threads, by thread id then URI: a diff may show the version a thread
   * is about under another URI than its canonical one (e.g. `HEAD` instead of the sha, or the
   * index as `""` instead of `~`). They exist while such a document is open.
   */
  private readonly aliases = new Map<string, Map<string, vscode.CommentThread>>();
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires when threads, drafts or reviews change (e.g. for the status bar). */
  readonly onDidChange = this.changed.event;
  private readonly agentReplied = new vscode.EventEmitter<AgentReply>();
  /** Fires when an agent comments in a thread (written by another process, picked up by the watcher). */
  readonly onDidReceiveAgentReply = this.agentReplied.event;
  private readonly published = new vscode.EventEmitter<Publication>();
  /** Fires when the user publishes comments: a direct comment, a reply outside a review, a review. */
  readonly onDidPublish = this.published.event;
  private watchers: vscode.Disposable[] = [];
  confirm: ConfirmHandler = modalConfirm;
  choose: ChooseHandler = warningChoice;
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
    this.aliases.forEach((byUri) => byUri.forEach((t) => t.dispose()));
    this.aliases.clear();
    this.liveRanges.clear();
    this.outdated.clear();
    this.activeReviews.clear();
    this.disposeWatchers();

    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
    await this.roots.init(folders.map((f) => f.uri.fsPath));
    this.ctx = { ...this.ctx, userName: await this.resolveUserName() };

    for (const root of this.roots.all()) {
      this.watchers.push(
        watchStore(root.path, {
          onThread: (threadId) => void this.refreshThread(root, threadId),
          onReviews: () => void this.refreshReviews(root),
        }),
      );
      try {
        const { threads, reviews, warnings } = await root.store.loadAll();
        warnings.forEach((w) => this.log.warn(`${root.path}: ${w}`));
        this.setActiveReview(root, latestActive(reviews));
        threads.forEach((state) => this.render(root, state));
        this.log.info(`${root.path}: ${threads.length} thread(s) loaded`);
        // Files may have changed while VS Code was closed: find the code again.
        await Promise.all(threads.map((state) => this.reanchorFromDisk(root, state.id)));
      } catch (err) {
        this.log.error(`${root.path}: failed to load threads`, err);
      }
    }
    this.updateReviewContext();
    await Promise.all(vscode.workspace.textDocuments.map((doc) => this.attachAliases(doc)));
  }

  /** Handler of the "Comment" / "Comment Now" buttons (or "Add to Review" with `draft`) under a new thread's input. */
  async submitNewComment(reply: vscode.CommentReply, opts: { draft?: boolean } = {}): Promise<void> {
    const { thread } = reply;
    const text = reply.text.trim();
    if (text === '' || this.byThread.has(thread)) return;

    try {
      const target = await this.anchorBaseFor(thread.uri);
      if (typeof target === 'string') {
        void vscode.window.showErrorMessage(`Local Review: ${target}`);
        return;
      }
      const { root, base } = target;
      const doc = await vscode.workspace.openTextDocument(thread.uri);
      // No range: a comment on the whole file.
      const anchor: Anchor = thread.range
        ? { ...base, ...buildAnchorContext(doc.getText(), toLineRange(thread.range.start, thread.range.end)) }
        : { ...base, range: null, snippet: '', contextBefore: [], contextAfter: [] };
      const reviewId = opts.draft ? (await this.ensureReview(root)).id : null;
      const state = await root.store.createThread(anchor, { author: 'user', body: text, reviewId });
      if (this.threadUri(root, state.anchor).toString() === thread.uri.toString()) {
        this.adopt(root, state, thread);
      } else {
        // Typed on another URI of the same version (e.g. `HEAD`): keep it as an alias of the canonical thread.
        this.render(root, state);
        this.addAlias(state.id, thread);
      }
      await this.excludeFromGit(root);
      if (!reviewId) this.published.fire({ root: root.path, kind: 'comment', threadIds: [state.id] });
    } catch (err) {
      this.log.error('Failed to save the comment', err);
      void vscode.window.showErrorMessage(`Local Review: the comment could not be saved (${String(err)}).`);
    }
  }

  /** Handler of the "Reply" button (or "Add to Review" with `draft`) under an existing thread. */
  async reply(reply: vscode.CommentReply, opts: { draft?: boolean } = {}): Promise<void> {
    const text = reply.text.trim();
    const threadId = this.byThread.get(reply.thread);
    const managed = threadId ? this.managed.get(threadId) : undefined;
    if (text === '' || !threadId || !managed) return;

    try {
      const reviewId = opts.draft ? (await this.ensureReview(managed.root)).id : null;
      const state = await managed.root.store.addComment(threadId, { author: 'user', body: text, reviewId });
      this.adopt(managed.root, state, managed.thread);
      if (!reviewId) this.published.fire({ root: managed.root.path, kind: 'reply', threadIds: [threadId] });
    } catch (err) {
      this.log.error('Failed to save the reply', err);
      void vscode.window.showErrorMessage(`Local Review: the reply could not be saved (${String(err)}).`);
    }
  }

  /** "Add to Review" under a thread's input: a draft, in the review in progress (started if needed). */
  async addToReview(reply: vscode.CommentReply): Promise<void> {
    if (this.byThread.has(reply.thread)) await this.reply(reply, { draft: true });
    else await this.submitNewComment(reply, { draft: true });
  }

  /** Roots with a review in progress. */
  reviewsInProgress(): { root: Root; review: ReviewState; drafts: number }[] {
    return this.roots.all().flatMap((root) => {
      const review = this.activeReviews.get(root.path);
      return review ? [{ root, review, drafts: this.draftCount(root) }] : [];
    });
  }

  /** Starts a review in a root (the one of the active editor by default), or returns the one in progress. */
  async ensureReview(root?: Root): Promise<ReviewState> {
    const target = root ?? this.defaultRoot();
    if (!target) throw new Error('No workspace folder');
    const existing = this.activeReviews.get(target.path);
    if (existing) return existing;
    const review = await target.store.startReview();
    this.setActiveReview(target, review);
    this.updateReviewContext();
    return review;
  }

  /** Publishes the review in progress of a root. Returns how many comments were published. */
  async submitReview(root: Root, summary?: string): Promise<number> {
    const review = this.activeReviews.get(root.path);
    if (!review) return 0;
    const published = this.draftCount(root);
    const threadIds = this.pendingThreads(root).map((t) => t.id);
    await root.store.submitReview(review.id, summary);
    this.setActiveReview(root, null);
    this.updateReviewContext();
    await this.refreshRoot(root);
    if (threadIds.length > 0) this.published.fire({ root: root.path, kind: 'review', threadIds, reviewId: review.id });
    return published;
  }

  /** Abandons the review in progress of a root: its drafts are dropped. Returns how many. */
  async discardReview(root: Root): Promise<number> {
    const review = this.activeReviews.get(root.path);
    if (!review) return 0;
    const dropped = this.draftCount(root);
    await root.store.discardReview(review.id);
    this.setActiveReview(root, null);
    this.updateReviewContext();
    await this.refreshRoot(root);
    return dropped;
  }

  /** Threads waiting for the user: the agent spoke last, and the thread is not resolved. */
  awaitingUser(): { id: string; state: ThreadState; line: number | null }[] {
    return [...this.managed.values()]
      .filter((m) => m.state.lastAuthor === 'agent' && m.state.status !== 'resolved')
      .map((m) => ({
        id: m.state.id,
        state: m.state,
        line: this.outdated.has(m.state.id) ? null : (this.currentRange(m.state)?.startLine ?? null),
      }));
  }

  /** Threads of a root holding at least one draft comment. */
  pendingThreads(root?: Root): { id: string; state: ThreadState }[] {
    return [...this.managed.values()]
      .filter((m) => (!root || m.root === root) && m.state.comments.some((c) => c.isDraft))
      .map((m) => ({ id: m.state.id, state: m.state }));
  }

  draftCount(root?: Root): number {
    return this.pendingThreads(root).reduce((n, t) => n + t.state.comments.filter((c) => c.isDraft).length, 0);
  }

  /**
   * Opens a thread's file, scrolls to it and expands it. When the file no longer exists (and was not
   * renamed), offers to resolve or delete the thread instead: there is nothing to open.
   */
  async reveal(threadId: string): Promise<'shown' | 'missing' | 'unknown'> {
    let m = this.managed.get(threadId);
    if (!m) return 'unknown';
    if (m.state.anchor.source === 'worktree' && !(await exists(this.fsPathOf(m)))) {
      await this.followRename(m.root, threadId);
      m = this.managed.get(threadId);
      if (!m) return 'unknown';
      if (!(await exists(this.fsPathOf(m)))) {
        await this.offerToClose(m);
        return 'missing';
      }
    }
    const editor = await vscode.window.showTextDocument(this.threadUri(m.root, m.state.anchor), { preview: false });
    if (m.thread.range) {
      editor.revealRange(m.thread.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      editor.selection = new vscode.Selection(m.thread.range.start, m.thread.range.start);
    }
    m.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    return 'shown';
  }

  /** A thread whose file was deleted can still be closed. */
  private async offerToClose(m: Managed): Promise<void> {
    const choice = await this.choose(
      `Local Review: the file of this thread no longer exists (${m.state.anchor.path}).`,
      m.state.readOnly ? [] : ['Resolve', 'Delete Thread'],
    );
    try {
      if (choice === 'Resolve') {
        const state = await m.root.store.setStatus(m.state.id, 'resolved', 'user');
        this.adopt(m.root, state, m.thread);
      } else if (choice === 'Delete Thread') {
        await m.root.store.deleteThread(m.state.id, 'user');
        this.forget(m.state.id);
      }
    } catch (err) {
      this.log.error('Failed to close the thread of a deleted file', err);
    }
  }

  /**
   * The file of a thread is gone: if git saw it renamed or moved, the thread follows it (and finds
   * its code there when it can). Returns whether the thread moved.
   */
  private async followRename(root: Root, threadId: string): Promise<boolean> {
    const m = this.managed.get(threadId);
    if (!m || !root.isGit || m.state.anchor.source !== 'worktree' || m.state.readOnly) return false;
    const newPath = await findRename(root.path, m.state.anchor.path);
    if (!newPath) return false;
    let text: string;
    try {
      text = await readFile(join(root.path, ...newPath.split('/')), 'utf8');
    } catch {
      return false;
    }
    const anchor = m.state.anchor;
    const found = anchor.range ? reanchor(anchor, text) : null;
    const located = found && found.kind !== 'lost';
    await this.moveThread(root, threadId, {
      ...anchor,
      path: newPath,
      ...(located ? buildAnchorContext(text, found.range) : {}),
    });
    if (anchor.range && !located) this.setOutdated(threadId, true);
    this.log.info(`${anchor.path} was renamed to ${newPath}: thread ${threadId} follows it`);
    return true;
  }

  /** Records a thread's new file and shows it there (a thread's URI cannot change in place). */
  private async moveThread(root: Root, threadId: string, anchor: Anchor): Promise<void> {
    try {
      const state = await root.store.updateAnchor(threadId, anchor, 'user');
      this.forget(threadId);
      this.render(root, state);
    } catch (err) {
      this.log.error(`Failed to move thread ${threadId} to ${anchor.path}`, err);
    }
  }

  /** Files or folders renamed in VS Code (Explorer, refactorings): their threads follow. */
  private async onFilesRenamed(e: vscode.FileRenameEvent): Promise<void> {
    for (const { oldUri, newUri } of e.files) {
      if (oldUri.scheme !== 'file' || newUri.scheme !== 'file') continue;
      for (const m of [...this.managed.values()]) {
        if (m.state.anchor.source !== 'worktree') continue;
        const current = this.fsPathOf(m);
        const moved =
          current === oldUri.fsPath
            ? newUri.fsPath
            : current.startsWith(oldUri.fsPath + sep)
              ? newUri.fsPath + current.slice(oldUri.fsPath.length)
              : undefined;
        if (!moved || this.roots.forFile(moved) !== m.root) continue;
        await this.moveThread(m.root, m.state.id, { ...m.state.anchor, path: Roots.anchorPath(m.root, moved) });
      }
    }
  }

  /** A review journal changed on disk (e.g. submitted from another window). */
  private async refreshReviews(root: Root): Promise<void> {
    try {
      const { reviews } = await root.store.loadReviews();
      this.setActiveReview(root, latestActive([...reviews.values()]));
      this.updateReviewContext();
      await this.refreshRoot(root);
    } catch (err) {
      this.log.error(`${root.path}: failed to reload reviews`, err);
    }
  }

  /** Re-reads every thread of a root: their draft state follows the reviews. */
  private async refreshRoot(root: Root): Promise<void> {
    const ids = [...this.managed.values()].filter((m) => m.root === root).map((m) => m.state.id);
    for (const id of ids) await this.refreshThread(root, id);
  }

  private setActiveReview(root: Root, review: ReviewState | null): void {
    if (review) this.activeReviews.set(root.path, review);
    else this.activeReviews.delete(root.path);
  }

  private updateReviewContext(): void {
    void vscode.commands.executeCommand('setContext', 'localReview.reviewActive', this.activeReviews.size > 0);
    this.changed.fire();
  }

  /** Root of the active editor, else the first one. */
  private defaultRoot(): Root | undefined {
    const active = vscode.window.activeTextEditor?.document.uri;
    return (active?.scheme === 'file' ? this.roots.forFile(active.fsPath) : undefined) ?? this.roots.all()[0];
  }

  /**
   * "Open Original Diff": reopens the diff a thread was made in, with the exact versions it
   * compared. Returns false when it cannot, e.g. a commit is gone after a rebase.
   */
  async openOriginalDiff(thread: vscode.CommentThread): Promise<boolean> {
    const threadId = this.byThread.get(thread);
    const m = threadId ? this.managed.get(threadId) : undefined;
    const diff = m?.state.anchor.diff;
    if (!m || !diff) return false;

    for (const side of [diff.base, diff.head]) {
      if (side.source === 'git' && side.sha && !(await commitExists(m.root.path, side.sha))) {
        void vscode.window.showErrorMessage(
          `Local Review: commit ${side.sha.slice(0, 7)} no longer exists (rewritten by a rebase?), so the original diff cannot be opened.`,
        );
        return false;
      }
    }
    const fileOf = (side: AnchorSide) => {
      const path = side.path ?? m.state.anchor.path;
      return isAbsolute(path) ? path : join(m.root.path, ...path.split('/'));
    };
    const uriOf = (side: AnchorSide) =>
      side.source === 'worktree'
        ? vscode.Uri.file(fileOf(side))
        : gitUri(fileOf(side), side.ref === '~' ? '~' : (side.sha ?? 'HEAD'));
    const name = (side: AnchorSide) => versionTag(side) ?? 'Working Tree';
    const [left, right] = [basename(fileOf(diff.base)), basename(fileOf(diff.head))];
    await vscode.commands.executeCommand(
      'vscode.diff',
      uriOf(diff.base),
      uriOf(diff.head),
      `${left} (${name(diff.base)}) ↔ ${right} (${name(diff.head)})`,
    );
    return true;
  }

  /** "Resolve" / "Reopen" from the thread header. Only the user resolves. */
  async setThreadStatus(thread: vscode.CommentThread, status: 'resolved' | 'open'): Promise<void> {
    const threadId = this.byThread.get(thread);
    const managed = threadId ? this.managed.get(threadId) : undefined;
    if (!threadId || !managed) return;

    try {
      const state = await managed.root.store.setStatus(threadId, status, 'user');
      this.adopt(managed.root, state, managed.thread);
      for (const t of this.instancesOf(threadId)) {
        t.collapsibleState =
          status === 'resolved'
            ? vscode.CommentThreadCollapsibleState.Collapsed
            : vscode.CommentThreadCollapsibleState.Expanded;
      }
    } catch (err) {
      this.log.error(`Failed to set thread status to ${status}`, err);
      void vscode.window.showErrorMessage(`Local Review: the thread could not be updated (${String(err)}).`);
    }
  }

  /** "Edit" on one of the user's comments: switches it to an inline editor. */
  editComment(comment: LrComment): void {
    const managed = this.managed.get(comment.threadId);
    if (!managed || !comment.isUserComment || managed.state.readOnly) return;
    comment.startEditing();
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
    const isDraft = managed.state.comments.find((c) => c.id === comment.commentId)?.isDraft ?? false;
    // A draft was never seen by anyone: deleting it needs no confirmation.
    const confirmed =
      isDraft ||
      (await this.confirm(
        'Delete this comment?',
        isLast
          ? 'It is the only comment of the thread: the thread will be deleted too.'
          : 'It will no longer be shown.',
        'Delete',
      ));
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
    const confirmed =
      managed.state.onlyDrafts ||
      (await this.confirm(
        'Delete this thread?',
        `Its ${n} comment${n > 1 ? 's' : ''}, including the agent's replies, will no longer be shown.`,
        'Delete Thread',
      ));
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

    const turnedToUser =
      awaitsUser(state) && (!awaitsUser(existing.state) || state.comments.length > existing.state.comments.length);
    const known = new Set(existing.state.comments.map((c) => c.id));
    const newFromAgent = state.comments.filter((c) => c.author === 'agent' && !known.has(c.id));
    this.adopt(root, state, existing.thread);
    const last = newFromAgent[newFromAgent.length - 1];
    if (last) {
      this.agentReplied.fire({
        threadId,
        agentName: last.agentName ?? DEFAULT_AGENT_NAME,
        path: state.anchor.path,
        line: this.outdated.has(threadId) ? null : (this.currentRange(state)?.startLine ?? null),
      });
    }
    // Bring the thread to the user's attention when the agent hands the ball back.
    if (turnedToUser) existing.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  }

  cancelNewThread(reply: vscode.CommentReply | vscode.CommentThread): void {
    const thread = 'thread' in reply ? reply.thread : reply;
    if (!this.byThread.has(thread)) thread.dispose();
  }

  /** Keeps thread positions in sync with document edits. */
  trackDocuments(): vscode.Disposable {
    return vscode.Disposable.from(
      vscode.workspace.onDidChangeTextDocument((e) => this.onDocumentChanged(e)),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        // The save records the tracked positions: a pending "clean again" check is superseded.
        this.cancelSettle(doc);
        void this.persistPositions(doc);
      }),
      vscode.workspace.onDidOpenTextDocument((doc) => void this.onDocumentOpened(doc)),
      vscode.workspace.onDidCloseTextDocument((doc) => void this.onDocumentClosed(doc)),
      vscode.workspace.onDidRenameFiles((e) => void this.onFilesRenamed(e)),
    );
  }

  /** Moves the threads of an edited document. Unsaved positions stay in memory until the file is saved. */
  private onDocumentChanged(e: vscode.TextDocumentChangeEvent): void {
    if (e.document.uri.scheme === 'git') {
      // A symbolic version moved (e.g. HEAD after a commit): the document shows another commit now.
      void this.reattachAliases(e.document);
      return;
    }
    if (e.contentChanges.length === 0) return;
    const changes = e.contentChanges.map((c) => ({
      startLine: c.range.start.line,
      startCharacter: c.range.start.character,
      endLine: c.range.end.line,
      endCharacter: c.range.end.character,
      text: c.text,
    }));
    for (const m of this.trackedThreadsOf(e.document.uri)) {
      if (this.outdated.has(m.state.id)) continue; // no position to track until its code is found again
      const { start, end } = toZeroBasedLines(this.currentRange(m.state)!);
      const next = applyChanges({ start, end }, changes);
      if (next === REMOVED) {
        // All its lines were deleted or replaced: outdated, never re-attached to the code around.
        this.liveRanges.delete(m.state.id);
        this.setOutdated(m.state.id, true);
        continue;
      }
      if (isBlank(e.document, next.start, next.end) && m.state.anchor.snippet.trim() !== '') {
        // Its text was cleared (select + Backspace leaves blank lines): the code is gone too.
        this.liveRanges.delete(m.state.id);
        this.setOutdated(m.state.id, true);
        continue;
      }
      if (next.start === start && next.end === end) continue;
      this.liveRanges.set(m.state.id, { startLine: next.start + 1, endLine: next.end + 1 });
      m.thread.range = new vscode.Range(next.start, 0, next.end, 0);
    }
    // A document that is still clean once the change has settled was reloaded from disk
    // (another tool changed the file, or the user reverted). The dirty flag is only reliable
    // after a moment: right after the first edit of a clean document, it still says "clean".
    const key = e.document.uri.toString();
    clearTimeout(this.settleTimers.get(key));
    this.settleTimers.set(
      key,
      setTimeout(() => {
        this.settleTimers.delete(key);
        if (e.document.isClosed) return;
        if (!e.document.isDirty) void this.resyncWithDisk(e.document);
        else this.recoverOutdated(e.document);
      }, SETTLE_MS),
    );
  }

  /**
   * While the user edits, an outdated thread whose code is back in the document (undo, paste,
   * a formatter rewriting the block the same way) attaches again right away. The position is
   * recorded on the next save, like any tracked position.
   */
  private recoverOutdated(doc: vscode.TextDocument): void {
    const text = doc.getText();
    for (const m of this.trackedThreadsOf(doc.uri)) {
      if (!this.outdated.has(m.state.id)) continue;
      const result = reanchor(m.state.anchor, text);
      if (!result || result.kind === 'lost') continue;
      this.liveRanges.set(m.state.id, result.range);
      this.setOutdated(m.state.id, false);
    }
  }

  private cancelSettle(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    clearTimeout(this.settleTimers.get(key));
    this.settleTimers.delete(key);
  }

  /**
   * After a reload from disk, line tracking cannot be trusted: VS Code applies the new content
   * as ONE replacement between the common first and last lines (e.g. `git stash` of edits above
   * and inside a thread replaces everything from line 1 down to the thread). So the tracked
   * position is dropped and the code is searched for in the new content instead. Nothing is
   * recorded when it is not found: the thread keeps its last recorded position.
   */
  private async resyncWithDisk(doc: vscode.TextDocument): Promise<void> {
    const text = doc.getText();
    for (const m of this.trackedThreadsOf(doc.uri)) {
      if (this.liveRanges.delete(m.state.id)) this.adopt(m.root, m.state, m.thread);
      await this.reanchorFromText(m.root, m.state.id, text);
    }
  }

  private async onDocumentOpened(doc: vscode.TextDocument): Promise<void> {
    if (doc.uri.scheme === 'git') {
      await this.attachAliases(doc);
      await this.reanchorOnIndex(doc);
      return;
    }
    if (doc.uri.scheme !== 'file' || doc.isDirty) return;
    for (const m of this.trackedThreadsOf(doc.uri)) {
      if (!this.liveRanges.has(m.state.id)) await this.reanchorFromText(m.root, m.state.id, doc.getText());
    }
  }

  /** Closing without saving drops unsaved positions: back to what matches the file on disk. */
  private async onDocumentClosed(doc: vscode.TextDocument): Promise<void> {
    if (doc.uri.scheme === 'git') {
      this.detachAliases(doc.uri);
      return;
    }
    for (const m of this.trackedThreadsOf(doc.uri)) {
      if (!this.liveRanges.delete(m.state.id)) continue;
      const range = threadRange(m.state);
      if (range) m.thread.range = range;
      await this.reanchorFromDisk(m.root, m.state.id);
    }
  }

  /** Writes the positions (and code snippets) that changed since the thread's anchor was recorded. */
  private async persistPositions(doc: vscode.TextDocument): Promise<void> {
    const text = doc.getText();
    for (const m of this.trackedThreadsOf(doc.uri)) {
      if (this.outdated.has(m.state.id)) {
        await this.reanchorFromText(m.root, m.state.id, text); // maybe the user typed its code back
        continue;
      }
      const range = this.currentRange(m.state)!;
      const context = buildAnchorContext(text, range);
      const unchanged = sameRange(context.range, m.state.anchor.range) && context.snippet === m.state.anchor.snippet;
      if (unchanged) {
        this.liveRanges.delete(m.state.id);
        continue;
      }
      await this.writeAnchor(m.root, m.state.id, { ...m.state.anchor, ...context }, range);
    }
  }

  private async reanchorFromDisk(root: Root, threadId: string): Promise<void> {
    const m = this.managed.get(threadId);
    if (!m || m.state.anchor.source !== 'worktree') return;
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === this.fsPathOf(m));
    if (open?.isDirty) return; // positions are tracked live until the next save
    let text: string;
    try {
      // The disk is the truth for a clean document: VS Code may keep a closed tab's document
      // around with stale content for a while.
      text = await readFile(this.fsPathOf(m), 'utf8');
    } catch {
      // The file itself is gone: renamed or moved (follow it), or deleted (outdated).
      if (!(await this.followRename(root, threadId))) this.setOutdated(threadId, true);
      return;
    }
    if (m.state.anchor.range) await this.reanchorFromText(root, threadId, text);
  }

  private async reanchorFromText(root: Root, threadId: string, text: string): Promise<void> {
    const m = this.managed.get(threadId);
    if (!m || m.state.readOnly) return;
    const result = reanchor(m.state.anchor, text);
    if (!result) return;
    if (result.kind === 'lost') {
      if (!this.outdated.has(threadId))
        this.log.info(`${m.state.anchor.path}: code of thread ${threadId} not found, outdated`);
      this.setOutdated(threadId, true);
      return;
    }
    this.setOutdated(threadId, false);
    // Moved, or only re-indented: record where the code is now, with its current text.
    if (result.kind !== 'exact') {
      await this.writeAnchor(root, threadId, { ...m.state.anchor, ...buildAnchorContext(text, result.range) });
    }
  }

  private setOutdated(threadId: string, outdated: boolean): void {
    if (this.outdated.has(threadId) === outdated) return;
    if (outdated) this.outdated.add(threadId);
    else this.outdated.delete(threadId);
    const m = this.managed.get(threadId);
    if (m) this.adopt(m.root, m.state, m.thread);
  }

  /** Persists a new anchor. `live` is the in-memory position it was computed from, if any. */
  private async writeAnchor(root: Root, threadId: string, anchor: Anchor, live?: LineRange): Promise<void> {
    try {
      const state = await root.store.updateAnchor(threadId, anchor, 'user');
      // Keep a newer unsaved position if the user kept typing meanwhile.
      if (!live || sameRange(this.liveRanges.get(threadId) ?? null, live)) this.liveRanges.delete(threadId);
      const m = this.managed.get(threadId);
      if (m) this.adopt(root, state, m.thread);
    } catch (err) {
      this.log.error(`Failed to record the new position of thread ${threadId}`, err);
    }
  }

  /** Worktree threads with a line range, shown on this document. */
  private trackedThreadsOf(uri: vscode.Uri): Managed[] {
    if (uri.scheme !== 'file') return [];
    return [...this.managed.values()].filter(
      (m) => m.state.anchor.source === 'worktree' && m.state.anchor.range && this.fsPathOf(m) === uri.fsPath,
    );
  }

  private fsPathOf(m: Managed): string {
    return join(m.root.path, ...m.state.anchor.path.split('/'));
  }

  private currentRange(state: ThreadState): LineRange | null {
    return this.liveRanges.get(state.id) ?? state.anchor.range;
  }

  /** Snapshot for tests and diagnostics. */
  /** Absolute path of a thread's file (the worktree file, also for a thread about a git version). */
  threadFile(threadId: string): string | undefined {
    const m = this.managed.get(threadId);
    return m ? join(m.root.path, ...m.state.anchor.path.split('/')) : undefined;
  }

  listThreads(): {
    id: string;
    /** Canonical URI first, then aliases. */
    uris: string[];
    rootPath: string;
    state: ThreadState;
    thread: vscode.CommentThread;
    outdated: boolean;
  }[] {
    return [...this.managed.entries()].map(([id, m]) => ({
      id,
      rootPath: m.root.path,
      state: m.state,
      thread: m.thread,
      uris: this.instancesOf(id).map((t) => t.uri.toString()),
      outdated: this.outdated.has(id),
    }));
  }

  dispose(): void {
    this.changed.dispose();
    this.agentReplied.dispose();
    this.published.dispose();
    this.settleTimers.forEach(clearTimeout);
    this.disposeWatchers();
    this.controller.dispose();
  }

  private forget(threadId: string): void {
    this.managed.get(threadId)?.thread.dispose();
    this.managed.delete(threadId);
    this.aliases.get(threadId)?.forEach((t) => t.dispose());
    this.aliases.delete(threadId);
    this.liveRanges.delete(threadId);
    this.outdated.delete(threadId);
    this.changed.fire();
  }

  private disposeWatchers(): void {
    this.watchers.forEach((w) => w.dispose());
    this.watchers = [];
  }

  private commentingRanges(doc: vscode.TextDocument): vscode.CommentingRanges {
    const fsPath = this.commentedFile(doc.uri);
    if (!fsPath || !this.roots.isCommentable(fsPath)) return { enableFileComments: false, ranges: [] };
    return { enableFileComments: true, ranges: [new vscode.Range(0, 0, Math.max(0, doc.lineCount - 1), 0)] };
  }

  /** The workspace file a document shows: itself, or the file of a git version. */
  private commentedFile(uri: vscode.Uri): string | undefined {
    if (uri.scheme === 'file') return uri.fsPath;
    if (uri.scheme === 'git') return parseGitQuery(uri.query)?.fsPath;
    return undefined;
  }

  /** Canonical URI of a thread: the file, the index, or the exact commit of a git version. */
  private threadUri(root: Root, anchor: Anchor): vscode.Uri {
    const fsPath = join(root.path, ...anchor.path.split('/'));
    if (anchor.source === 'worktree') return vscode.Uri.file(fsPath);
    return gitUri(fsPath, anchor.ref === '~' ? '~' : (anchor.sha ?? anchor.ref ?? 'HEAD'));
  }

  /** Where a new thread's anchor points: the working tree file, or a git version of it. */
  private async anchorBaseFor(uri: vscode.Uri): Promise<{ root: Root; base: AnchorBase } | string> {
    const fsPath = this.commentedFile(uri);
    const root = fsPath ? this.roots.forFile(fsPath) : undefined;
    if (!fsPath || !root) return 'this file is not part of any workspace folder.';
    const side = await this.sideOf(uri);
    if (!side) return 'this version of the file cannot be resolved in git.';
    return { root, base: { path: Roots.anchorPath(root, fsPath), ...side, diff: await this.diffInfoFor(uri, root) } };
  }

  /** Which version a document shows. `null` when a git ref cannot be resolved. */
  private async sideOf(uri: vscode.Uri): Promise<AnchorSide | null> {
    if (uri.scheme === 'file') return { source: 'worktree', ref: null, sha: null };
    const parsed = uri.scheme === 'git' ? parseGitQuery(uri.query) : null;
    const root = parsed ? this.roots.forFile(parsed.fsPath) : undefined;
    if (!parsed || !root) return null;
    if (isIndexRef(parsed.ref)) return { source: 'git', ref: '~', sha: null };
    const sha = await resolveCommit(root.path, parsed.ref);
    return sha ? { source: 'git', ref: anchorRef(parsed.ref), sha } : null;
  }

  /** The diff a document is a side of, if it is shown in one. Side paths are relative to `root`. */
  private async diffInfoFor(uri: vscode.Uri, root: Root): Promise<DiffInfo | undefined> {
    const key = uri.toString();
    for (const tab of vscode.window.tabGroups.all.flatMap((g) => g.tabs)) {
      const input = tab.input;
      if (!(input instanceof vscode.TabInputTextDiff)) continue;
      const side = input.original.toString() === key ? 'base' : input.modified.toString() === key ? 'head' : undefined;
      if (!side) continue;
      const [base, head] = await Promise.all([
        this.diffSideOf(input.original, root),
        this.diffSideOf(input.modified, root),
      ]);
      if (base && head) return { side, base, head };
    }
    return undefined;
  }

  /** A side of a diff: its version and its file (both sides may be different files). */
  private async diffSideOf(uri: vscode.Uri, root: Root): Promise<AnchorSide | null> {
    const side = await this.sideOf(uri);
    const fsPath = this.commentedFile(uri);
    if (!side || !fsPath) return null;
    const inRoot = this.roots.forFile(fsPath) === root;
    return { ...side, path: inRoot ? Roots.anchorPath(root, fsPath) : fsPath };
  }

  /** Canonical instance and aliases of a thread. */
  private instancesOf(threadId: string): vscode.CommentThread[] {
    const m = this.managed.get(threadId);
    return [...(m ? [m.thread] : []), ...(this.aliases.get(threadId)?.values() ?? [])];
  }

  private addAlias(threadId: string, thread: vscode.CommentThread): void {
    const m = this.managed.get(threadId);
    if (!m) return;
    let byUri = this.aliases.get(threadId);
    if (!byUri) this.aliases.set(threadId, (byUri = new Map()));
    const key = thread.uri.toString();
    const previous = byUri.get(key);
    if (previous && previous !== thread) previous.dispose();
    byUri.set(key, thread);
    this.byThread.set(thread, threadId);
    this.adopt(m.root, m.state, m.thread);
  }

  /** Shows the git threads about the version this document shows, when it uses another URI. */
  private async attachAliases(doc: vscode.TextDocument): Promise<void> {
    if (doc.uri.scheme !== 'git') return;
    const side = await this.sideOf(doc.uri);
    const fsPath = this.commentedFile(doc.uri);
    const root = fsPath ? this.roots.forFile(fsPath) : undefined;
    if (!side || !fsPath || !root) return;
    const path = Roots.anchorPath(root, fsPath);
    const key = doc.uri.toString();
    for (const m of this.managed.values()) {
      const a = m.state.anchor;
      const sameVersion =
        a.source === 'git' && a.path === path && (a.ref === '~' ? side.ref === '~' : a.sha === side.sha);
      if (!sameVersion || m.thread.uri.toString() === key || this.aliases.get(m.state.id)?.has(key)) continue;
      const alias = this.controller.createCommentThread(doc.uri, m.thread.range ?? new vscode.Range(0, 0, 0, 0), []);
      alias.collapsibleState =
        m.state.status === 'resolved'
          ? vscode.CommentThreadCollapsibleState.Collapsed
          : vscode.CommentThreadCollapsibleState.Expanded;
      this.addAlias(m.state.id, alias);
    }
  }

  private async reattachAliases(doc: vscode.TextDocument): Promise<void> {
    this.detachAliases(doc.uri);
    await this.attachAliases(doc);
  }

  private detachAliases(uri: vscode.Uri): void {
    const key = uri.toString();
    for (const byUri of this.aliases.values()) {
      byUri.get(key)?.dispose();
      byUri.delete(key);
    }
  }

  /** The index changes as files are staged: index threads find their code again, like worktree ones. */
  private async reanchorOnIndex(doc: vscode.TextDocument): Promise<void> {
    const parsed = parseGitQuery(doc.uri.query);
    const root = parsed ? this.roots.forFile(parsed.fsPath) : undefined;
    if (!parsed || !root || !isIndexRef(parsed.ref)) return;
    const path = Roots.anchorPath(root, parsed.fsPath);
    for (const m of [...this.managed.values()]) {
      if (m.state.anchor.source === 'git' && m.state.anchor.ref === '~' && m.state.anchor.path === path) {
        await this.reanchorFromText(root, m.state.id, doc.getText());
      }
    }
  }

  private render(root: Root, state: ThreadState): void {
    const uri = this.threadUri(root, state.anchor);
    // A file comment is created without a range. The API allows it at creation (unlike setting
    // `range = undefined` later, which never reaches the editor), though its typing says otherwise.
    const range = threadRange(state) ?? (undefined as unknown as vscode.Range);
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
    const outdated = this.outdated.has(state.id);
    const current = this.currentRange(state);
    if (outdated && !state.anchor.range) {
      // A file comment stays a file comment: it has no line to lose.
    } else if (outdated) {
      // Shown on line 1, never on lines that are not its code. Not `undefined` (file level):
      // VS Code drops `undefined` when it sends a thread update to the editor, which then keeps
      // the old range and stretches it as the file changes.
      thread.range = new vscode.Range(0, 0, 0, 0);
    } else if (current) {
      const { start, end } = toZeroBasedLines(current);
      thread.range = new vscode.Range(start, 0, end, 0);
    }
    applyThreadState(thread, state, this.ctx, { outdated });
    for (const alias of this.aliases.get(state.id)?.values() ?? []) {
      alias.range = thread.range;
      applyThreadState(alias, state, this.ctx, { outdated });
    }
    this.managed.set(state.id, { state, root, thread });
    this.byThread.set(thread, state.id);
    this.changed.fire();
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

function sameRange(a: LineRange | null, b: LineRange | null): boolean {
  return a?.startLine === b?.startLine && a?.endLine === b?.endLine;
}

function isBlank(doc: vscode.TextDocument, start: number, end: number): boolean {
  for (let line = start; line <= Math.min(end, doc.lineCount - 1); line++) {
    if (!doc.lineAt(line).isEmptyOrWhitespace) return false;
  }
  return true;
}

function latestActive(reviews: readonly ReviewState[]): ReviewState | null {
  const active = reviews.filter((r) => r.state === 'active');
  active.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
  return active[0] ?? null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

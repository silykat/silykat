import { access, readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { basename, isAbsolute, join, sep } from 'node:path';
import * as vscode from 'vscode';
import {
  branchKey,
  branchOfTopic,
  buildAnchorContext,
  localBranches,
  reanchor,
  renamedBranch,
  topicOf,
  type Anchor,
  type BranchRef,
  type AnchorSide,
  type DiffInfo,
  type LineRange,
  type ReviewState,
  type ThreadState,
} from '@local-review/core';
import { Branches } from './branches';
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
  kind: 'comment' | 'reply' | 'review' | 'edit' | 'delete';
  threadIds: string[];
  reviewId?: string;
  /** Files of threads that no longer exist (deleted), by thread id: to know who to tell. */
  files?: Record<string, string>;
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
  /** The reviews in progress: one per branch of each root, by `reviewKey`. */
  private readonly activeReviews = new Map<string, { root: Root; review: ReviewState }>();
  /** Which branch is checked out where, to show each thread on its branch only. */
  readonly branches = new Branches();
  /** Threads of branches that are not checked out: kept, but not shown. */
  private readonly hidden = new Map<string, { root: Root; state: ThreadState }>();
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
  /**
   * Asked before comments are published (not for drafts), with their files: `false` cancels. Set by
   * the deliveries, which warn when no agent session is subscribed to them.
   */
  publishGate: (root: string, files: string[]) => Promise<boolean> = async () => true;
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
    this.hidden.clear();
    this.branches.clear();
    this.disposeWatchers();

    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
    await this.roots.init(folders.map((f) => f.uri.fsPath));
    this.ctx = { ...this.ctx, userName: await this.resolveUserName() };

    for (const root of this.roots.all()) {
      this.watchers.push(
        watchStore(
          root.store.dir,
          {
            onThread: (threadId) => void this.refreshThread(root, threadId),
            onReviews: () => void this.refreshReviews(root),
          },
          { outsideWorkspace: root.loose === true },
        ),
      );
      try {
        const { threads: loaded, warnings } = await root.store.loadAll();
        warnings.forEach((w) => this.log.warn(`${root.path}: ${w}`));
        for (const review of await root.store.activeReviews()) this.setActiveReview(root, review);
        const threads = await Promise.all(loaded.map((state) => this.withBranch(root, state)));
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
      if (!opts.draft && !(await this.publishGate(root.path, [join(root.path, ...base.path.split('/'))]))) return;
      const doc = await vscode.workspace.openTextDocument(thread.uri);
      // No range: a comment on the whole file.
      const anchor: Anchor = thread.range
        ? { ...base, ...buildAnchorContext(doc.getText(), toLineRange(thread.range.start, thread.range.end)) }
        : { ...base, range: null, snippet: '', contextBefore: [], contextAfter: [] };
      const file = join(root.path, ...base.path.split('/'));
      const branch = branchOfTopic(await topicOf(file));
      await this.branches.learn(file);
      const reviewId = opts.draft ? (await this.ensureReview(root, branch)).id : null;
      const state = await root.store.createThread(anchor, { author: 'user', body: text, reviewId }, branch);
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
      if (!opts.draft && !(await this.publishGate(managed.root.path, [this.threadFile(threadId)!]))) return;
      const reviewId = opts.draft ? (await this.ensureReview(managed.root, managed.state.branch)).id : null;
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

  /** The reviews in progress: at most one per branch of each root. */
  reviewsInProgress(): { root: Root; review: ReviewState; drafts: number }[] {
    return [...this.activeReviews.values()].map(({ root, review }) => ({
      root,
      review,
      drafts: this.draftCount(review),
    }));
  }

  /**
   * Starts a review of a branch (by default: the branch of the active editor's file, in its root),
   * or returns the one in progress there.
   */
  async ensureReview(root?: Root, branch?: BranchRef | null): Promise<ReviewState> {
    const target = root ?? this.defaultRoot();
    if (!target) throw new Error('No workspace folder');
    const onBranch = branch !== undefined ? branch : await this.activeEditorBranch();
    const existing = this.activeReviews.get(reviewKey(target, onBranch));
    if (existing) return existing.review;
    const review = await target.store.startReview(onBranch);
    this.setActiveReview(target, review);
    this.updateReviewContext();
    return review;
  }

  /** The branch checked out where the active editor's file is, as last seen (no git call). */
  activeEditorCheckedOut(): BranchRef | null | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const file = uri ? this.commentedFile(uri) : undefined;
    return file ? this.branches.checkedOut(file) : undefined;
  }

  /** The branch of the file in the active editor, if any. */
  async activeEditorBranch(): Promise<BranchRef | null> {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const file = uri ? this.commentedFile(uri) : undefined;
    return file ? branchOfTopic(await topicOf(file)) : null;
  }

  /** Publishes a review in progress. Returns how many comments were published. */
  async submitReview(root: Root, review: ReviewState, summary?: string): Promise<number> {
    const published = this.draftCount(review);
    const threadIds = this.pendingThreads(review).map((t) => t.id);
    await root.store.submitReview(review.id, summary);
    this.setActiveReview(root, review, null);
    this.updateReviewContext();
    await this.refreshRoot(root);
    if (threadIds.length > 0) this.published.fire({ root: root.path, kind: 'review', threadIds, reviewId: review.id });
    return published;
  }

  /** Abandons a review in progress: its drafts are dropped. Returns how many. */
  async discardReview(root: Root, review: ReviewState): Promise<number> {
    const dropped = this.draftCount(review);
    await root.store.discardReview(review.id);
    this.setActiveReview(root, review, null);
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

  /** Threads holding draft comments (of that review), shown or not. */
  pendingThreads(review?: ReviewState): { id: string; state: ThreadState }[] {
    return this.allThreads()
      .filter(({ state }) => state.comments.some((c) => c.isDraft && (!review || c.reviewId === review.id)))
      .map(({ state }) => ({ id: state.id, state }));
  }

  draftCount(review?: ReviewState): number {
    return this.pendingThreads(review).reduce(
      (n, t) => n + t.state.comments.filter((c) => c.isDraft && (!review || c.reviewId === review.id)).length,
      0,
    );
  }

  /** Whether a thread is shown (on the branch checked out), rather than kept for its branch. */
  isShown(threadId: string): boolean {
    return this.managed.has(threadId);
  }

  /** Every thread: shown ones, and those kept for branches that are not checked out. */
  private allThreads(): { root: Root; state: ThreadState }[] {
    return [...[...this.managed.values()].map((m) => ({ root: m.root, state: m.state })), ...this.hidden.values()];
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
    const current = this.managed.get(threadId);
    if (current && !(await this.stillOnItsBranch(root, current.state))) return;
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
      for (const [key, entry] of this.activeReviews) if (entry.root === root) this.activeReviews.delete(key);
      for (const review of await root.store.activeReviews()) this.setActiveReview(root, review);
      this.updateReviewContext();
      await this.refreshRoot(root);
    } catch (err) {
      this.log.error(`${root.path}: failed to reload reviews`, err);
    }
  }

  /** Re-reads every thread of a root: their draft state follows the reviews. */
  private async refreshRoot(root: Root): Promise<void> {
    const ids = this.allThreads()
      .filter((t) => t.root === root)
      .map((t) => t.state.id);
    for (const id of ids) await this.refreshThread(root, id);
  }

  /** Records a review in progress; with `null` as third argument, that it is over. */
  private setActiveReview(root: Root, review: ReviewState, ended?: null): void {
    if (ended === null) this.activeReviews.delete(reviewKey(root, review.branch));
    else this.activeReviews.set(reviewKey(root, review.branch), { root, review });
  }

  /** The contexts last set, for tests: a review in progress anywhere, and on the active editor's branch. */
  readonly reviewContext = { active: false, here: false };

  /**
   * `localReview.reviewActive`: a review is in progress somewhere (Submit, Discard…).
   * `localReview.reviewActiveHere`: one is in progress on the branch of the active editor's file,
   * which decides whether new comments are drafts first ("Add to Review") or published first.
   */
  private updateReviewContext(): void {
    this.setReviewContext('active', this.activeReviews.size > 0);
    this.changed.fire();
    void this.reviewHere().then((here) => this.setReviewContext('here', here));
  }

  private setReviewContext(which: 'active' | 'here', value: boolean): void {
    this.reviewContext[which] = value;
    const key = which === 'active' ? 'localReview.reviewActive' : 'localReview.reviewActiveHere';
    void vscode.commands.executeCommand('setContext', key, value);
  }

  /** Whether a review is in progress on the branch of the active editor's file. */
  private async reviewHere(): Promise<boolean> {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const file = uri ? this.commentedFile(uri) : undefined;
    const root = file ? this.roots.forFile(file) : undefined;
    if (!file || !root) return false;
    const branch = branchOfTopic(await topicOf(file));
    return this.activeReviews.has(reviewKey(root, branch));
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
      const wasPublished = !managed.state.comments.find((c) => c.id === comment.commentId)?.isDraft;
      const state = await managed.root.store.editComment(comment.threadId, comment.commentId, text, 'user');
      this.adopt(managed.root, state, managed.thread);
      // Agents saw the old version: they are told (a draft was never seen by anyone).
      if (wasPublished) this.published.fire({ root: managed.root.path, kind: 'edit', threadIds: [state.id] });
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
      const file = this.fileOf(managed.root, managed.state);
      const state = await managed.root.store.deleteComment(comment.threadId, comment.commentId, 'user');
      if (state.deleted) this.forget(state.id);
      else this.adopt(managed.root, state, managed.thread);
      if (!isDraft)
        this.published.fire({
          root: managed.root.path,
          kind: 'delete',
          threadIds: [state.id],
          files: { [state.id]: file },
        });
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
      const file = this.fileOf(managed.root, managed.state);
      await managed.root.store.deleteThread(threadId, 'user');
      this.forget(threadId);
      if (managed.state.hasPublished)
        this.published.fire({
          root: managed.root.path,
          kind: 'delete',
          threadIds: [threadId],
          files: { [threadId]: file },
        });
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
    await this.branches.learn(this.fileOf(root, state));
    if (!this.onItsBranch(root, state)) {
      this.hide(root, state);
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
      // Draft first or publish first depends on the review of the branch of the file shown.
      vscode.window.onDidChangeActiveTextEditor(() => this.updateReviewContext()),
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
    const current = this.managed.get(threadId);
    // Right after a checkout, the file shows another branch: nothing to record for this thread.
    if (current && !(await this.stillOnItsBranch(root, current.state))) return;
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
    const m = this.managed.get(threadId) ?? this.hidden.get(threadId);
    return m ? this.fileOf(m.root, m.state) : undefined;
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
    this.hidden.delete(threadId);
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

  /**
   * Learns where a thread's file is, and gives a thread created before branches existed the branch
   * checked out there now (outside git, and for files ignored by git, it has none).
   */
  private async withBranch(root: Root, state: ThreadState): Promise<ThreadState> {
    const file = this.fileOf(root, state);
    await this.branches.learn(file);
    if (state.branch || state.readOnly || state.deleted) return state;
    const branch = branchOfTopic(await topicOf(file));
    if (!branch) return state;
    try {
      return await root.store.setBranch(state.id, branch);
    } catch (err) {
      this.log.warn(`${root.path}: could not record the branch of thread ${state.id}`, err);
      return state;
    }
  }

  private fileOf(root: Root, state: ThreadState): string {
    return join(root.path, ...state.anchor.path.split('/'));
  }

  /** A thread is shown on its branch only: when that branch is checked out where its file is. */
  private onItsBranch(root: Root, state: ThreadState): boolean {
    if (!state.branch) return true;
    const checkedOut = this.branches.checkedOut(this.fileOf(root, state));
    // Not known yet: shown, until the next look at the branches says otherwise.
    return checkedOut === undefined || branchKey(checkedOut) === branchKey(state.branch);
  }

  /** Same check, reading git now: before writing anything computed from the file's content. */
  private async stillOnItsBranch(root: Root, state: ThreadState): Promise<boolean> {
    if (!state.branch) return true;
    return branchKey(await this.branches.readNow(this.fileOf(root, state))) === branchKey(state.branch);
  }

  /** Keeps a thread of a branch that is not checked out, without showing it. */
  private hide(root: Root, state: ThreadState): void {
    if (this.managed.has(state.id)) this.forget(state.id);
    this.hidden.set(state.id, { root, state });
    this.changed.fire();
  }

  /** Shows, or hides, the threads of worktrees whose branch changed. */
  private async applyBranches(): Promise<void> {
    this.updateReviewContext(); // the branch of the active editor may have changed
    for (const m of [...this.managed.values()]) if (!this.onItsBranch(m.root, m.state)) this.hide(m.root, m.state);
    for (const { root, state } of [...this.hidden.values()]) {
      if (!this.onItsBranch(root, state)) continue;
      this.hidden.delete(state.id);
      this.render(root, state);
      await this.reanchorFromDisk(root, state.id);
    }
  }

  /**
   * Follows the branches: shows each thread on its branch (after a checkout), and when a branch is
   * renamed its threads and review follow it; when it is deleted, they are deleted too.
   */
  trackBranches(intervalMs = 2000): vscode.Disposable {
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        await this.refreshBranches();
      } catch (err) {
        this.log.error('Failed to follow the git branches', err);
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => void tick(), intervalMs);
    return { dispose: () => clearInterval(timer) };
  }

  /** One look at the branches now (it is also done every few seconds). */
  async refreshBranches(): Promise<void> {
    if ((await this.branches.refresh()).length > 0) await this.applyBranches();
    await this.followBranchChanges();
  }

  /** Ids of the threads kept for branches that are not checked out. */
  hiddenThreads(): string[] {
    return [...this.hidden.keys()];
  }

  /** Branches of threads or reviews that no longer exist: renamed (follow) or deleted (delete). */
  async followBranchChanges(): Promise<void> {
    const owners = new Map<string, { root: Root; branch: BranchRef }>();
    for (const { root, state } of this.allThreads())
      if (state.branch) owners.set(branchKey(state.branch), { root, branch: state.branch });
    for (const { root, review } of this.activeReviews.values())
      if (review.branch) owners.set(branchKey(review.branch), { root, branch: review.branch });
    const existing = new Map<string, Set<string>>(); // repo → its local branches
    for (const [key, { root, branch }] of owners) {
      const dir = branch.worktree ?? root.path;
      if (!existing.has(branch.repo))
        existing.set(branch.repo, await localBranches(dir).catch(() => new Set<string>()));
      const branches = existing.get(branch.repo)!;
      // An empty list means git could not be asked: never delete anything on that basis.
      if (branches.size === 0 || branches.has(branch.branch)) continue;
      const renamed = await renamedBranch(dir, branch.branch);
      await this.onBranchGone(root, key, renamed ? { ...branch, branch: renamed } : null);
    }
  }

  private async onBranchGone(root: Root, key: string, renamedTo: BranchRef | null): Promise<void> {
    for (const t of this.allThreads().filter((t) => t.root === root && branchKey(t.state.branch) === key)) {
      try {
        if (renamedTo) await root.store.setBranch(t.state.id, renamedTo);
        else await root.store.deleteThread(t.state.id, 'user');
      } catch (err) {
        this.log.warn(`${root.path}: could not update thread ${t.state.id} of a gone branch`, err);
      }
      await this.refreshThread(root, t.state.id);
    }
    for (const { review } of [...this.activeReviews.values()].filter(
      (r) => r.root === root && branchKey(r.review.branch) === key,
    )) {
      try {
        if (renamedTo) await root.store.setReviewBranch(review.id, renamedTo);
        else await root.store.discardReview(review.id);
      } catch (err) {
        this.log.warn(`${root.path}: could not update review ${review.id} of a gone branch`, err);
      }
    }
    await this.refreshReviews(root);
    this.log.info(`${root.path}: branch ${key} ${renamedTo ? `renamed to ${renamedTo.branch}` : 'deleted'}`);
  }

  private render(root: Root, state: ThreadState): void {
    if (!this.onItsBranch(root, state)) {
      this.hide(root, state);
      return;
    }
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
    this.hidden.delete(state.id);
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

/** One review per branch of each root. */
const reviewKey = (root: Root, branch: BranchRef | null): string => `${root.path}|${branchKey(branch)}`;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

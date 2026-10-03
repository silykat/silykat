import * as vscode from 'vscode';
import { AgentRepliesUi, type Notifier } from './agentReplies';
import { ReviewController, type ChooseHandler, type ConfirmHandler } from './controller';
import { simulateAgentReply, type SimulateArgs } from './dev/simulateAgentReply';
import { DeliveriesUi, type NoSubscriberPrompt, type Warner } from './deliveries';
import { createLog } from './log';
import type { LrComment } from './render';
import { RetroReminderUi, type ReminderPrompt } from './retroReminder';
import { ReviewUi, type SummaryPrompt } from './review';
import { SessionsUi } from './sessions';

export interface LocalReviewApi {
  readonly controller: vscode.CommentController;
  reload(): Promise<void>;
  listThreads: ReviewController['listThreads'];
  /** Tests only: answer confirmation dialogs without showing them. */
  setConfirmHandler(handler: ConfirmHandler | undefined): void;
  /** Tests only: pick among offered actions without showing them. */
  setChooseHandler(handler: ChooseHandler | undefined): void;
  reveal: ReviewController['reveal'];
  /** Tests only: answer the review summary prompt without showing it (`undefined` = Esc). */
  setSummaryPrompt(prompt: SummaryPrompt | undefined): void;
  /** Tests only: the review status bar text, `undefined` when hidden. */
  reviewStatusText(): string | undefined;
  reviewsInProgress: ReviewController['reviewsInProgress'];
  /** Tests only: capture agent reply notifications (return true to click their action). */
  setNotifier(notifier: Notifier | undefined): void;
  /** Tests only: the "waiting for your reply" status bar text, `undefined` when hidden. */
  awaitingStatusText(): string | undefined;
  awaitingUser: ReviewController['awaitingUser'];
  /** Tests only: the agent sessions shown, after re-reading the registry. */
  refreshSessions(): Promise<{ statusText: string | undefined; all: string[]; relevant: string[] }>;
  /** Tests only: the agent sessions shown right now, as last polled. */
  shownSessions(): string[];
  /** Tests only: capture the messages about deliveries (return the action to click). */
  setDeliveryWarner(warner: Warner | undefined): void;
  /** Tests only: look at the git branches now (also done every few seconds). */
  refreshBranches(): Promise<void>;
  /** Tests only: whether a review is in progress anywhere, and on the active editor's branch. */
  reviewContext(): { active: boolean; here: boolean };
  /** Tests only: threads kept for branches that are not checked out. */
  hiddenThreads(): string[];
  /** Tests only: warn about a git worktree with comments, as when its folder is opened. */
  warnIfWorktree(path: string): Promise<void>;
  /** Tests only: forget which worktrees were warned about. */
  forgetWorktreeWarnings(): Promise<void>;
  /** Tests only: answer "publish without subscribers?" without showing it. */
  setNoSubscriberPrompt(prompt: NoSubscriberPrompt | undefined): void;
  /** Tests only: measure the retro cadence now; the retro status bar text, `undefined` when hidden. */
  refreshRetroReminder(): Promise<{ statusText: string | undefined; due: string[] }>;
  /** Tests only: answer the retro reminder message without showing it. */
  setRetroReminderPrompt(prompt: ReminderPrompt | undefined): void;
}

export async function activate(context: vscode.ExtensionContext): Promise<LocalReviewApi> {
  const log = createLog();
  const review = new ReviewController(log, context.extensionUri);
  const reviewUi = new ReviewUi(review);
  const agentReplies = new AgentRepliesUi(review);
  const sessions = new SessionsUi();
  const deliveries = new DeliveriesUi(review, log);
  const retroReminder = new RetroReminderUi(review.onDidChange);
  context.subscriptions.push(log, review, reviewUi, agentReplies, sessions, deliveries, retroReminder);

  context.subscriptions.push(
    vscode.commands.registerCommand('localReview.commentSelection', () =>
      // The native command opens a new thread on the current selection through our controller.
      vscode.commands.executeCommand('workbench.action.addComment'),
    ),
    vscode.commands.registerCommand('localReview.commentFile', async (uri?: vscode.Uri) => {
      // From a tab's context menu, `uri` is that tab's file: bring it to the front first.
      if (uri instanceof vscode.Uri) await vscode.window.showTextDocument(uri, { preview: false });
      // The native command opens a new file-level thread (no line) through our controller.
      await vscode.commands.executeCommand('workbench.action.addComment', { fileComment: true });
    }),
    vscode.commands.registerCommand('localReview.submitComment', (reply: vscode.CommentReply) =>
      review.submitNewComment(reply),
    ),
    vscode.commands.registerCommand('localReview.commentNow', (reply: vscode.CommentReply) =>
      review.submitNewComment(reply),
    ),
    vscode.commands.registerCommand('localReview.reply', (reply: vscode.CommentReply) => review.reply(reply)),
    vscode.commands.registerCommand('localReview.replyNow', (reply: vscode.CommentReply) => review.reply(reply)),
    vscode.commands.registerCommand('localReview.resolveThread', (thread: vscode.CommentThread) =>
      review.setThreadStatus(thread, 'resolved'),
    ),
    vscode.commands.registerCommand('localReview.reopenThread', (thread: vscode.CommentThread) =>
      review.setThreadStatus(thread, 'open'),
    ),
    vscode.commands.registerCommand('localReview.openOriginalDiff', (thread: vscode.CommentThread) =>
      review.openOriginalDiff(thread),
    ),
    vscode.commands.registerCommand('localReview.editComment', (c: LrComment) => review.editComment(c)),
    vscode.commands.registerCommand('localReview.saveEdit', (c: LrComment) => review.saveEdit(c)),
    vscode.commands.registerCommand('localReview.cancelEdit', (c: LrComment) => review.cancelEdit(c)),
    vscode.commands.registerCommand('localReview.deleteComment', (c: LrComment) => review.deleteComment(c)),
    vscode.commands.registerCommand('localReview.deleteThread', (t: vscode.CommentThread) => review.deleteThread(t)),
    vscode.commands.registerCommand('localReview.cancelNewThread', (reply: vscode.CommentReply) =>
      review.cancelNewThread(reply),
    ),
    vscode.commands.registerCommand('localReview.saveWorktreeThreads', (target?: vscode.Uri) =>
      review.saveWorktreeThreads(target instanceof vscode.Uri ? target : undefined),
    ),
    vscode.commands.registerCommand('localReview.dev.simulateAgentReply', (args?: SimulateArgs) =>
      simulateAgentReply(review, context.extensionUri, args),
    ),
    review.trackDocuments(),
    review.trackBranches(),
    vscode.workspace.onDidChangeWorkspaceFolders(() => review.reload()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('localReview.userName')) void review.reload();
    }),
  );

  review.worktreeWarnings = rememberedSet(context.globalState, 'localReview.warnedWorktrees');
  const defaultConfirm = review.confirm;
  const defaultChoose = review.choose;
  const defaultSummaryPrompt = reviewUi.promptSummary;
  const defaultNotifier = agentReplies.notify;
  const defaultWarner = deliveries.warn;
  const defaultNoSubscriberPrompt = deliveries.askNoSubscriber;
  const defaultRetroPrompt = retroReminder.prompt;
  await review.reload();
  log.info('Local Review activated');

  return {
    controller: review.controller,
    reload: () => review.reload(),
    listThreads: () => review.listThreads(),
    setConfirmHandler: (handler) => {
      review.confirm = handler ?? defaultConfirm;
    },
    setChooseHandler: (handler) => {
      review.choose = handler ?? defaultChoose;
    },
    reveal: (threadId) => review.reveal(threadId),
    setSummaryPrompt: (prompt) => {
      reviewUi.promptSummary = prompt ?? defaultSummaryPrompt;
    },
    reviewStatusText: () => reviewUi.statusText,
    reviewsInProgress: () => review.reviewsInProgress(),
    setNotifier: (notifier) => {
      agentReplies.notify = notifier ?? defaultNotifier;
    },
    awaitingStatusText: () => agentReplies.statusText,
    awaitingUser: () => review.awaitingUser(),
    setDeliveryWarner: (warner) => {
      deliveries.warn = warner ?? defaultWarner;
    },
    refreshBranches: () => review.refreshBranches(),
    hiddenThreads: () => review.hiddenThreads(),
    reviewContext: () => ({ ...review.reviewContext }),
    setNoSubscriberPrompt: (prompt) => {
      deliveries.askNoSubscriber = prompt ?? defaultNoSubscriberPrompt;
    },
    refreshRetroReminder: async () => {
      await retroReminder.refresh();
      return {
        statusText: retroReminder.statusText,
        due: retroReminder.cadences.filter((c) => c.due).map((c) => c.root),
      };
    },
    setRetroReminderPrompt: (prompt) => {
      retroReminder.prompt = prompt ?? defaultRetroPrompt;
    },
    warnIfWorktree: (path) => review.warnIfWorktree(path),
    forgetWorktreeWarnings: () => Promise.resolve(context.globalState.update('localReview.warnedWorktrees', undefined)),
    shownSessions: () => sessions.sessions.relevant.map((s) => s.id),
    refreshSessions: async () => {
      await sessions.refresh();
      return {
        statusText: sessions.statusText,
        all: sessions.sessions.all.map((s) => s.id),
        relevant: sessions.sessions.relevant.map((s) => s.id),
      };
    },
  };
}

/** A set of strings kept in the extension's state, across restarts. */
function rememberedSet(state: vscode.Memento, key: string): { has(v: string): boolean; add(v: string): void } {
  const all = () => state.get<string[]>(key) ?? [];
  return {
    has: (v) => all().includes(v),
    add: (v) => void state.update(key, [...all().filter((x) => x !== v), v]),
  };
}

export function deactivate(): void {}

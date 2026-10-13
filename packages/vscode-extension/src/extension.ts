import * as vscode from 'vscode';
import { AgentRepliesUi, type Notifier } from './agentReplies';
import { ArchiveUi } from './archive';
import { HistoryUi, type ErasePrompt } from './history';
import { RetroSessionsSetting } from './retroSessions';
import { ReviewController, type ChooseHandler, type ConfirmHandler } from './controller';
import { simulateAgentReply, type SimulateArgs } from './dev/simulateAgentReply';
import { DeliveriesUi, type NoSubscriberPrompt, type Warner } from './deliveries';
import { createLog } from './log';
import type { SlkComment } from './render';
import { RetroReminderUi, type ReminderPrompt } from './retroReminder';
import { ReviewUi, type SummaryPrompt } from './review';
import { SessionsUi } from './sessions';

export interface SilykatApi {
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
  /** Tests only: answer the prompts of the archive and clean-up commands (`undefined`: the real ones). */
  setArchivePrompts(
    prompts: Partial<Pick<ArchiveUi, 'askDate' | 'pickThreads' | 'askSaveLocation' | 'inform'>> | undefined,
  ): void;
  /** Tests only: answer the offer to erase the history kept (`undefined`: the real one). */
  setErasePrompt(prompt: ErasePrompt | undefined): void;
  /** Tests only: the last offer to erase the history kept, once answered (how many threads were erased). */
  lastEraseOffer(): Promise<number | undefined>;
}

export async function activate(context: vscode.ExtensionContext): Promise<SilykatApi> {
  const log = createLog();
  const review = new ReviewController(log, context.extensionUri);
  const reviewUi = new ReviewUi(review);
  const agentReplies = new AgentRepliesUi(review);
  const sessions = new SessionsUi();
  const deliveries = new DeliveriesUi(review, log);
  const retroReminder = new RetroReminderUi(review.onDidChange);
  const archive = new ArchiveUi(review, log);
  const history = new HistoryUi(() => review.rootPaths(), log);
  const retroSessions = new RetroSessionsSetting(log);
  context.subscriptions.push(
    log,
    review,
    reviewUi,
    agentReplies,
    sessions,
    deliveries,
    retroReminder,
    archive,
    history,
    retroSessions,
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('silykat.commentSelection', () =>
      // The native command opens a new thread on the current selection through our controller.
      vscode.commands.executeCommand('workbench.action.addComment'),
    ),
    vscode.commands.registerCommand('silykat.commentFile', async (uri?: vscode.Uri) => {
      // From a tab's context menu, `uri` is that tab's file: bring it to the front first.
      if (uri instanceof vscode.Uri) await vscode.window.showTextDocument(uri, { preview: false });
      // The native command opens a new file-level thread (no line) through our controller.
      await vscode.commands.executeCommand('workbench.action.addComment', { fileComment: true });
    }),
    vscode.commands.registerCommand('silykat.submitComment', (reply: vscode.CommentReply) =>
      review.submitNewComment(reply),
    ),
    vscode.commands.registerCommand('silykat.commentNow', (reply: vscode.CommentReply) =>
      review.submitNewComment(reply),
    ),
    vscode.commands.registerCommand('silykat.reply', (reply: vscode.CommentReply) => review.reply(reply)),
    vscode.commands.registerCommand('silykat.replyNow', (reply: vscode.CommentReply) => review.reply(reply)),
    vscode.commands.registerCommand('silykat.resolveThread', (thread: vscode.CommentThread) =>
      review.setThreadStatus(thread, 'resolved'),
    ),
    vscode.commands.registerCommand('silykat.reopenThread', (thread: vscode.CommentThread) =>
      review.setThreadStatus(thread, 'open'),
    ),
    vscode.commands.registerCommand('silykat.openOriginalDiff', (thread: vscode.CommentThread) =>
      review.openOriginalDiff(thread),
    ),
    vscode.commands.registerCommand('silykat.editComment', (c: SlkComment) => review.editComment(c)),
    vscode.commands.registerCommand('silykat.saveEdit', (c: SlkComment) => review.saveEdit(c)),
    vscode.commands.registerCommand('silykat.cancelEdit', (c: SlkComment) => review.cancelEdit(c)),
    vscode.commands.registerCommand('silykat.deleteComment', (c: SlkComment) => review.deleteComment(c)),
    vscode.commands.registerCommand('silykat.deleteThread', (t: vscode.CommentThread) => review.deleteThread(t)),
    vscode.commands.registerCommand('silykat.cancelNewThread', (reply: vscode.CommentReply) =>
      review.cancelNewThread(reply),
    ),
    vscode.commands.registerCommand('silykat.saveWorktreeThreads', (target?: vscode.Uri) =>
      review.saveWorktreeThreads(target instanceof vscode.Uri ? target : undefined),
    ),
    vscode.commands.registerCommand('silykat.dev.simulateAgentReply', (args?: SimulateArgs) =>
      simulateAgentReply(review, context.extensionUri, args),
    ),
    review.trackDocuments(),
    review.trackBranches(),
    vscode.workspace.onDidChangeWorkspaceFolders(() => review.reload()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('silykat.userName')) void review.reload();
    }),
  );

  review.worktreeWarnings = rememberedSet(context.globalState, 'silykat.warnedWorktrees');
  const defaultConfirm = review.confirm;
  const defaultChoose = review.choose;
  const defaultSummaryPrompt = reviewUi.promptSummary;
  const defaultNotifier = agentReplies.notify;
  const defaultWarner = deliveries.warn;
  const defaultNoSubscriberPrompt = deliveries.askNoSubscriber;
  const defaultRetroPrompt = retroReminder.prompt;
  const defaultErasePrompt = history.prompt;
  const archivePrompts = {
    askDate: archive.askDate,
    pickThreads: archive.pickThreads,
    askSaveLocation: archive.askSaveLocation,
    inform: archive.inform,
  };
  await review.reload();
  log.info('silykat activated');

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
    setArchivePrompts: (prompts) => {
      Object.assign(archive, archivePrompts, prompts ?? {});
    },
    setErasePrompt: (prompt) => {
      history.prompt = prompt ?? defaultErasePrompt;
    },
    lastEraseOffer: () => history.offered,
    warnIfWorktree: (path) => review.warnIfWorktree(path),
    forgetWorktreeWarnings: () => Promise.resolve(context.globalState.update('silykat.warnedWorktrees', undefined)),
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

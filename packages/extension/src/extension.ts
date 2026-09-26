import * as vscode from 'vscode';
import { ReviewController, type ConfirmHandler } from './controller';
import { simulateAgentReply, type SimulateArgs } from './dev/simulateAgentReply';
import { createLog } from './log';
import type { LrComment } from './render';

export interface LocalReviewApi {
  readonly controller: vscode.CommentController;
  reload(): Promise<void>;
  listThreads: ReviewController['listThreads'];
  /** Tests only: answer confirmation dialogs without showing them. */
  setConfirmHandler(handler: ConfirmHandler | undefined): void;
}

export async function activate(context: vscode.ExtensionContext): Promise<LocalReviewApi> {
  const log = createLog();
  const review = new ReviewController(log, context.extensionUri);
  context.subscriptions.push(log, review);

  context.subscriptions.push(
    vscode.commands.registerCommand('localReview.commentSelection', () =>
      // The native command opens a new thread on the current selection through our controller.
      vscode.commands.executeCommand('workbench.action.addComment'),
    ),
    vscode.commands.registerCommand('localReview.submitComment', (reply: vscode.CommentReply) =>
      review.submitNewComment(reply),
    ),
    vscode.commands.registerCommand('localReview.reply', (reply: vscode.CommentReply) => review.reply(reply)),
    vscode.commands.registerCommand('localReview.resolveThread', (thread: vscode.CommentThread) =>
      review.setThreadStatus(thread, 'resolved'),
    ),
    vscode.commands.registerCommand('localReview.reopenThread', (thread: vscode.CommentThread) =>
      review.setThreadStatus(thread, 'open'),
    ),
    vscode.commands.registerCommand('localReview.editComment', (c: LrComment) => review.editComment(c)),
    vscode.commands.registerCommand('localReview.saveEdit', (c: LrComment) => review.saveEdit(c)),
    vscode.commands.registerCommand('localReview.cancelEdit', (c: LrComment) => review.cancelEdit(c)),
    vscode.commands.registerCommand('localReview.deleteComment', (c: LrComment) => review.deleteComment(c)),
    vscode.commands.registerCommand('localReview.deleteThread', (t: vscode.CommentThread) => review.deleteThread(t)),
    vscode.commands.registerCommand('localReview.cancelNewThread', (reply: vscode.CommentReply) =>
      review.cancelNewThread(reply),
    ),
    vscode.commands.registerCommand('localReview.dev.simulateAgentReply', (args?: SimulateArgs) =>
      simulateAgentReply(review, context.extensionUri, args),
    ),
    vscode.workspace.onDidChangeWorkspaceFolders(() => review.reload()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('localReview.userName')) void review.reload();
    }),
  );

  const defaultConfirm = review.confirm;
  await review.reload();
  log.info('Local Review activated');

  return {
    controller: review.controller,
    reload: () => review.reload(),
    listThreads: () => review.listThreads(),
    setConfirmHandler: (handler) => {
      review.confirm = handler ?? defaultConfirm;
    },
  };
}

export function deactivate(): void {}

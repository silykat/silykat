import * as vscode from 'vscode';
import { ReviewController } from './controller';
import { createLog } from './log';

export interface LocalReviewApi {
  readonly controller: vscode.CommentController;
  reload(): Promise<void>;
  listThreads: ReviewController['listThreads'];
}

export async function activate(context: vscode.ExtensionContext): Promise<LocalReviewApi> {
  const log = createLog();
  const review = new ReviewController(log);
  context.subscriptions.push(log, review);

  context.subscriptions.push(
    vscode.commands.registerCommand('localReview.commentSelection', () =>
      // The native command opens a new thread on the current selection through our controller.
      vscode.commands.executeCommand('workbench.action.addComment'),
    ),
    vscode.commands.registerCommand('localReview.submitComment', (reply: vscode.CommentReply) =>
      review.submitNewComment(reply),
    ),
    vscode.commands.registerCommand('localReview.cancelNewThread', (reply: vscode.CommentReply) =>
      review.cancelNewThread(reply),
    ),
    vscode.workspace.onDidChangeWorkspaceFolders(() => review.reload()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('localReview.userName')) void review.reload();
    }),
  );

  await review.reload();
  log.info('Local Review activé');

  return {
    controller: review.controller,
    reload: () => review.reload(),
    listThreads: () => review.listThreads(),
  };
}

export function deactivate(): void {}

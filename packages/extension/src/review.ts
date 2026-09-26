import * as vscode from 'vscode';
import type { ReviewController } from './controller';
import type { Root } from './roots';

/** Asks for the optional review summary. `undefined` means the user cancelled (Esc). Replaceable in tests. */
export type SummaryPrompt = () => Promise<string | undefined>;

const inputBoxSummary: SummaryPrompt = () =>
  Promise.resolve(
    vscode.window.showInputBox({
      title: 'Submit Review',
      prompt: 'Review summary (optional). Press Enter to submit, Esc to cancel.',
      placeHolder: 'Overall comment for the agent, like a GitHub review body',
    }),
  );

/** Review mode UI: status bar item, submit, pending comments. */
export class ReviewUi implements vscode.Disposable {
  private readonly statusBar = vscode.window.createStatusBarItem(
    'localReview.review',
    vscode.StatusBarAlignment.Left,
    100,
  );
  private readonly subscriptions: vscode.Disposable[] = [];
  promptSummary: SummaryPrompt = inputBoxSummary;

  constructor(private readonly review: ReviewController) {
    this.statusBar.name = 'Local Review';
    this.statusBar.command = 'localReview.reviewMenu';
    this.subscriptions.push(
      review.onDidChange(() => this.update()),
      vscode.commands.registerCommand('localReview.startReview', (reply?: vscode.CommentReply) => this.start(reply)),
      vscode.commands.registerCommand('localReview.addToReview', (reply: vscode.CommentReply) =>
        review.addToReview(reply),
      ),
      vscode.commands.registerCommand('localReview.submitReview', () => this.submit()),
      vscode.commands.registerCommand('localReview.discardReview', () => this.discard()),
      vscode.commands.registerCommand('localReview.showPendingComments', () => this.showPending()),
      vscode.commands.registerCommand('localReview.reviewMenu', () => this.menu()),
      vscode.commands.registerCommand('localReview.revealThread', (threadId: string) => review.reveal(threadId)),
    );
    this.update();
  }

  /** Text of the status bar item, `undefined` when hidden. For tests. */
  get statusText(): string | undefined {
    return this.review.reviewsInProgress().length > 0 ? this.statusBar.text : undefined;
  }

  dispose(): void {
    this.subscriptions.forEach((s) => s.dispose());
    this.statusBar.dispose();
  }

  private update(): void {
    const inProgress = this.review.reviewsInProgress();
    if (inProgress.length === 0) {
      this.statusBar.hide();
      return;
    }
    const drafts = inProgress.reduce((n, r) => n + r.drafts, 0);
    this.statusBar.text = `$(comment-draft) Review · ${drafts}`;
    this.statusBar.tooltip = `Local Review: review in progress, ${drafts} pending comment${drafts === 1 ? '' : 's'}. Click to submit it or see them.`;
    this.statusBar.show();
  }

  /** "Start Review": from a comment input, it also adds that comment as the first draft. */
  private async start(reply?: vscode.CommentReply): Promise<void> {
    if (reply?.thread) {
      await this.review.addToReview(reply);
      return;
    }
    try {
      await this.review.ensureReview();
      void vscode.window.showInformationMessage(
        'Local Review: review started. New comments are pending until you submit it.',
      );
    } catch (err) {
      void vscode.window.showErrorMessage(`Local Review: could not start a review (${String(err)}).`);
    }
  }

  private async menu(): Promise<void> {
    const pick = await vscode.window.showQuickPick(
      [
        { label: '$(check) Submit Review', run: () => this.submit() },
        { label: '$(list-unordered) Show Pending Comments', run: () => this.showPending() },
        { label: '$(trash) Discard Review', run: () => this.discard() },
      ],
      { title: 'Local Review: review in progress' },
    );
    await pick?.run();
  }

  /** "Submit Review": publishes the drafts, with an optional summary. Esc on the summary cancels. */
  async submit(): Promise<number> {
    const root = await this.pickRoot();
    if (!root) return 0;
    if (this.review.draftCount(root) === 0) {
      void vscode.window.showInformationMessage('Local Review: no pending comments to submit.');
      return 0;
    }
    const summary = await this.promptSummary();
    if (summary === undefined) return 0; // cancelled: the drafts stay drafts
    try {
      const n = await this.review.submitReview(root, summary);
      void vscode.window.showInformationMessage(`Local Review: review submitted (${n} comment${n === 1 ? '' : 's'}).`);
      return n;
    } catch (err) {
      void vscode.window.showErrorMessage(`Local Review: the review could not be submitted (${String(err)}).`);
      return 0;
    }
  }

  /** "Discard Review": deletes every draft of the review, after confirmation. */
  async discard(): Promise<number> {
    const root = await this.pickRoot();
    if (!root) return 0;
    const n = this.review.draftCount(root);
    const confirmed =
      n === 0 ||
      (await this.review.confirm(
        `Delete ${n} pending comment${n === 1 ? '' : 's'}?`,
        'The review is discarded. Threads that only hold pending comments disappear; published threads are kept.',
        'Discard Review',
      ));
    if (!confirmed) return 0;
    try {
      const dropped = await this.review.discardReview(root);
      void vscode.window.showInformationMessage(
        `Local Review: review discarded (${dropped} pending comment${dropped === 1 ? '' : 's'} deleted).`,
      );
      return dropped;
    } catch (err) {
      void vscode.window.showErrorMessage(`Local Review: the review could not be discarded (${String(err)}).`);
      return 0;
    }
  }

  private async showPending(): Promise<void> {
    const items = this.review.pendingThreads().map(({ id, state }) => {
      const r = state.anchor.range;
      const draft = state.comments.find((c) => c.isDraft);
      return {
        label: `${state.anchor.path}${r ? `:${r.startLine}${r.endLine !== r.startLine ? `-${r.endLine}` : ''}` : ''}`,
        description: draft?.body.split('\n')[0],
        id,
      };
    });
    if (items.length === 0) {
      void vscode.window.showInformationMessage('Local Review: no pending comments.');
      return;
    }
    const pick = await vscode.window.showQuickPick(items, {
      title: 'Pending comments',
      placeHolder: 'Go to a pending comment',
    });
    if (pick) await this.review.reveal(pick.id);
  }

  /** The root whose review to act on: the only one in progress, or the user's choice. */
  private async pickRoot(): Promise<Root | undefined> {
    const inProgress = this.review.reviewsInProgress();
    if (inProgress.length <= 1) return inProgress[0]?.root;
    const pick = await vscode.window.showQuickPick(
      inProgress.map((r) => ({ label: r.root.path, description: `${r.drafts} pending`, root: r.root })),
      { title: 'Submit which review?' },
    );
    return pick?.root;
  }
}

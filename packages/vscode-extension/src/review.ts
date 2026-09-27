import { basename } from 'node:path';
import * as vscode from 'vscode';
import { branchKey, type ReviewState } from '@local-review/core';
import type { ReviewController } from './controller';
import type { Root } from './roots';

interface InProgress {
  root: Root;
  review: ReviewState;
  drafts: number;
}

/** A review as the user tells it apart: its folder and branch, e.g. "therapy · feature-x". */
const reviewLabel = (r: InProgress) =>
  `${basename(r.root.path)}${r.review.branch ? ` · ${r.review.branch.branch}` : ''}`;

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
      // The review shown is the one of the active editor's branch.
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
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
    const branch = this.review.activeEditorCheckedOut();
    const mine =
      branch === undefined ? undefined : inProgress.find((r) => branchKey(r.review.branch) === branchKey(branch));
    const shown = mine ?? (inProgress.length === 1 ? inProgress[0]! : undefined);
    const drafts = shown ? shown.drafts : inProgress.reduce((n, r) => n + r.drafts, 0);
    this.statusBar.text = shown
      ? `$(comment-draft) Review · ${drafts}`
      : `$(comment-draft) ${inProgress.length} reviews · ${drafts}`;
    this.statusBar.tooltip =
      inProgress.length === 1
        ? `Local Review: review in progress (${reviewLabel(inProgress[0]!)}), ${drafts} pending comment${drafts === 1 ? '' : 's'}. Click to submit it or see them.`
        : `Local Review: reviews in progress, one per branch: ${inProgress.map((r) => `${reviewLabel(r)} (${r.drafts})`).join(', ')}.`;
    this.statusBar.show();
  }

  /** The review of the branch of the active editor's file, if one is in progress. */
  private async ofActiveEditor(inProgress: InProgress[]): Promise<InProgress | undefined> {
    if (!vscode.window.activeTextEditor) return undefined;
    const branch = await this.review.activeEditorBranch();
    return inProgress.find((r) => branchKey(r.review.branch) === branchKey(branch));
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
    const target = await this.pickReview('Submit which review?');
    if (!target) return 0;
    const { root, review } = target;
    if (this.review.draftCount(review) === 0) {
      void vscode.window.showInformationMessage('Local Review: no pending comments to submit.');
      return 0;
    }
    const files = this.review.pendingThreads(review).flatMap((t) => this.review.threadFile(t.id) ?? []);
    if (!(await this.review.publishGate(root.path, files))) return 0; // cancelled: the drafts stay drafts
    const summary = await this.promptSummary();
    if (summary === undefined) return 0; // cancelled: the drafts stay drafts
    try {
      const n = await this.review.submitReview(root, review, summary);
      void vscode.window.showInformationMessage(`Local Review: review submitted (${n} comment${n === 1 ? '' : 's'}).`);
      return n;
    } catch (err) {
      void vscode.window.showErrorMessage(`Local Review: the review could not be submitted (${String(err)}).`);
      return 0;
    }
  }

  /** "Discard Review": deletes every draft of the review, after confirmation. */
  async discard(): Promise<number> {
    const target = await this.pickReview('Discard which review?');
    if (!target) return 0;
    const n = this.review.draftCount(target.review);
    const confirmed =
      n === 0 ||
      (await this.review.confirm(
        `Delete ${n} pending comment${n === 1 ? '' : 's'}?`,
        'The review is discarded. Threads that only hold pending comments disappear; published threads are kept.',
        'Discard Review',
      ));
    if (!confirmed) return 0;
    try {
      const dropped = await this.review.discardReview(target.root, target.review);
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
    const items = this.review
      .pendingThreads()
      .filter(({ id }) => this.review.isShown(id)) // the branch of the others is not checked out
      .map(({ id, state }) => {
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

  /**
   * The review to act on: the one of the active editor's branch, else the only one in progress,
   * else the user's choice.
   */
  private async pickReview(title: string): Promise<InProgress | undefined> {
    const inProgress = this.review.reviewsInProgress();
    if (inProgress.length <= 1) return inProgress[0];
    const mine = await this.ofActiveEditor(inProgress);
    if (mine) return mine;
    const pick = await vscode.window.showQuickPick(
      inProgress.map((r) => ({ label: reviewLabel(r), description: `${r.drafts} pending`, target: r })),
      { title },
    );
    return pick?.target;
  }
}

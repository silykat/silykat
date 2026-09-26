import * as vscode from 'vscode';
import type { AgentReply, ReviewController } from './controller';

/** Shows a notification with one action; resolves to true if the action was chosen. Replaceable in tests. */
export type Notifier = (message: string, action: string) => Promise<boolean>;

const infoNotifier: Notifier = async (message, action) =>
  (await vscode.window.showInformationMessage(message, action)) === action;

/** Replies arriving within this window are announced together. */
const GROUP_MS = 500;

/** Tells the user when the agent replied: a notification, and a status bar counter (threads waiting for them). */
export class AgentRepliesUi implements vscode.Disposable {
  private readonly statusBar = vscode.window.createStatusBarItem(
    'localReview.awaitingUser',
    vscode.StatusBarAlignment.Left,
    99,
  );
  private readonly subscriptions: vscode.Disposable[] = [];
  private pending: AgentReply[] = [];
  private timer: NodeJS.Timeout | undefined;
  notify: Notifier = infoNotifier;

  constructor(private readonly review: ReviewController) {
    this.statusBar.name = 'Local Review: replies';
    this.statusBar.command = 'localReview.showAwaitingUser';
    this.subscriptions.push(
      review.onDidChange(() => this.update()),
      review.onDidReceiveAgentReply((reply) => this.onReply(reply)),
      vscode.commands.registerCommand('localReview.showAwaitingUser', () => this.showAwaitingUser()),
    );
    this.update();
  }

  /** Text of the status bar item, `undefined` when hidden. For tests. */
  get statusText(): string | undefined {
    return this.review.awaitingUser().length > 0 ? this.statusBar.text : undefined;
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.subscriptions.forEach((s) => s.dispose());
    this.statusBar.dispose();
  }

  private update(): void {
    const waiting = this.review.awaitingUser();
    if (waiting.length === 0) {
      this.statusBar.hide();
      return;
    }
    const n = waiting.length;
    this.statusBar.text = `$(comment-unresolved) ${n}`;
    this.statusBar.tooltip = `Local Review: ${n} thread${n === 1 ? '' : 's'} waiting for your reply. Click to see ${n === 1 ? 'it' : 'them'}.`;
    this.statusBar.show();
  }

  private onReply(reply: AgentReply): void {
    if (!vscode.workspace.getConfiguration('localReview').get<boolean>('notifyOnAgentReply', true)) return;
    this.pending = [...this.pending.filter((p) => p.threadId !== reply.threadId), reply];
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), GROUP_MS);
  }

  /**
   * One notification per burst of replies, about the threads still waiting for the user: not
   * those deleted meanwhile, or already answered or resolved in the meantime.
   */
  private async flush(): Promise<void> {
    const waiting = new Set(this.review.awaitingUser().map((t) => t.id));
    const replies = this.pending.filter((r) => waiting.has(r.threadId));
    this.pending = [];
    if (replies.length === 0) return;
    const names = [...new Set(replies.map((r) => r.agentName))];
    const who = names.length === 1 ? names[0]! : 'Agents';
    if (replies.length === 1) {
      const r = replies[0]!;
      const where = r.line === null ? r.path : `${r.path}:${r.line}`;
      if (await this.notify(`Local Review: ${who} replied on ${where}`, 'Open')) await this.review.reveal(r.threadId);
      return;
    }
    if (await this.notify(`Local Review: ${who} replied on ${replies.length} threads`, 'Show')) {
      await this.showAwaitingUser();
    }
  }

  private async showAwaitingUser(): Promise<void> {
    const items = this.review.awaitingUser().map(({ id, state, line }) => ({
      label: `${state.anchor.path}${line === null ? '' : `:${line}`}`,
      description: state.comments[state.comments.length - 1]?.body.split('\n')[0],
      id,
    }));
    if (items.length === 0) {
      void vscode.window.showInformationMessage('Local Review: no thread is waiting for your reply.');
      return;
    }
    const pick = await vscode.window.showQuickPick(items, {
      title: 'Threads waiting for your reply',
      placeHolder: 'Go to a thread',
    });
    if (pick) await this.review.reveal(pick.id);
  }
}

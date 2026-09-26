import * as vscode from 'vscode';
import { localReviewHome, relevantSessions, SessionRegistry, type Session } from '@local-review/core';

const POLL_MS = 2000;

/** Shows the agent sessions of this workspace in the status bar, and lists them all on demand. */
export class SessionsUi implements vscode.Disposable {
  private readonly statusBar = vscode.window.createStatusBarItem(
    'localReview.sessions',
    vscode.StatusBarAlignment.Left,
    98,
  );
  private readonly registry = new SessionRegistry(localReviewHome());
  private readonly timer: NodeJS.Timeout;
  private readonly command: vscode.Disposable;
  private all: Session[] = [];
  private relevant: Session[] = [];
  private waiting = 0;
  private visible = false;

  constructor(
    private readonly hooks: {
      /** Published threads of these folders still waiting for a session. */
      waitingCount?: (folders: string[]) => Promise<number>;
      /** After each look at the registry: e.g. to send waiting comments to a session just started. */
      onRefresh?: (folders: string[]) => Promise<void>;
    } = {},
  ) {
    this.statusBar.name = 'Local Review: agent sessions';
    this.statusBar.command = 'localReview.showSessions';
    this.command = vscode.commands.registerCommand('localReview.showSessions', () => this.show());
    this.timer = setInterval(() => void this.refresh(), POLL_MS);
    void this.refresh();
  }

  /** Status bar text, `undefined` when hidden. For tests. */
  get statusText(): string | undefined {
    return this.visible ? this.statusBar.text : undefined;
  }

  get sessions(): { all: Session[]; relevant: Session[] } {
    return { all: this.all, relevant: this.relevant };
  }

  /** Re-reads the registry now (it is also polled). */
  async refresh(): Promise<void> {
    try {
      this.all = await this.registry.list(); // also drops sessions whose process is gone
    } catch {
      this.all = [];
    }
    const folders = (vscode.workspace.workspaceFolders ?? [])
      .filter((f) => f.uri.scheme === 'file')
      .map((f) => f.uri.fsPath);
    this.relevant = relevantSessions(this.all, folders);
    // Not awaited: it may ask the user which session to use.
    void this.hooks.onRefresh?.(folders).catch(() => undefined);
    this.waiting = (await this.hooks.waitingCount?.(folders).catch(() => 0)) ?? 0;
    this.render();
  }

  dispose(): void {
    clearInterval(this.timer);
    this.command.dispose();
    this.statusBar.dispose();
  }

  private render(): void {
    const [only, ...others] = this.relevant;
    const waiting = this.waiting > 0 ? ` · ${this.waiting} waiting` : '';
    if (!only) {
      this.visible = this.waiting > 0;
      if (!this.visible) return this.statusBar.hide();
      this.statusBar.text = `$(hubot) No agent session${waiting}`;
      this.statusBar.tooltip = `Local Review: ${this.waiting} published comment thread(s) will go to the next agent session started on this workspace.`;
      return this.statusBar.show();
    }
    this.visible = true;
    this.statusBar.text =
      (others.length === 0
        ? `$(hubot) ${only.agent}${only.branch ? ` · ${only.branch}` : ''}${only.push === false ? ' $(warning)' : ''}`
        : `$(hubot) ${this.relevant.length} agent sessions${this.relevant.some((s) => s.push === false) ? ' $(warning)' : ''}`) +
      waiting;
    this.statusBar.tooltip = new vscode.MarkdownString(
      ['**Local Review: agent sessions of this workspace**', ...this.relevant.map(describe)].join('\n\n'),
      true,
    );
    this.statusBar.show();
  }

  private async show(): Promise<void> {
    await this.refresh();
    if (this.all.length === 0) {
      void vscode.window.showInformationMessage(
        'Local Review: no agent session is running. Start one (e.g. `claude` with the local-review plugin) and it shows up here.',
      );
      return;
    }
    const relevant = new Set(this.relevant.map((s) => s.id));
    const sorted = [...this.all].sort((a, b) => Number(relevant.has(b.id)) - Number(relevant.has(a.id)));
    await vscode.window.showQuickPick(
      sorted.map((s) => ({
        label: `$(hubot) ${s.agent}${s.branch ? ` · ${s.branch}` : ''}${s.push === false ? ' $(warning)' : ''}`,
        description: relevant.has(s.id) ? 'this workspace' : undefined,
        detail: s.cwd,
      })),
      { title: 'Running agent sessions', placeHolder: 'Sessions registered with Local Review' },
    );
  }
}

function describe(s: Session): string {
  const line = `${s.agent}${s.branch ? ` · \`${s.branch}\`` : ''} — ${s.cwd}`;
  if (s.push !== false) return line;
  const fix = s.pushCommand ? ` Relaunch it with \`${s.pushCommand}\`.` : '';
  return `${line}\n\n$(warning) Can't be notified of your comments: it sees them when you ask it.${fix}`;
}

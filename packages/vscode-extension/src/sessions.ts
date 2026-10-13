import * as vscode from 'vscode';
import { silykatHome, relevantSessions, SessionRegistry, type Session } from '@silykat/core';
import { sessionLabel, sessionTopics } from './sessionLabel';

const POLL_MS = 2000;

/** Shows the agent sessions of this workspace in the status bar, and lists them all on demand. */
export class SessionsUi implements vscode.Disposable {
  private readonly statusBar = vscode.window.createStatusBarItem(
    'silykat.sessions',
    vscode.StatusBarAlignment.Left,
    98,
  );
  private readonly registry = new SessionRegistry(silykatHome());
  private readonly timer: NodeJS.Timeout;
  private readonly command: vscode.Disposable;
  private all: Session[] = [];
  private relevant: Session[] = [];

  constructor() {
    this.statusBar.name = 'silykat: agent sessions';
    this.statusBar.command = 'silykat.showSessions';
    this.command = vscode.commands.registerCommand('silykat.showSessions', () => this.show());
    this.timer = setInterval(() => void this.refresh(), POLL_MS);
    void this.refresh();
  }

  /** Status bar text, `undefined` when hidden. For tests. */
  get statusText(): string | undefined {
    return this.relevant.length > 0 ? this.statusBar.text : undefined;
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
    this.render();
  }

  dispose(): void {
    clearInterval(this.timer);
    this.command.dispose();
    this.statusBar.dispose();
  }

  private render(): void {
    const [only, ...others] = this.relevant;
    if (!only) {
      this.statusBar.hide();
      return;
    }
    const warning = this.relevant.some((s) => s.push === false) ? ' $(warning)' : '';
    this.statusBar.text =
      others.length === 0
        ? `$(hubot) ${sessionLabel(only)}${warning}`
        : `$(hubot) ${this.relevant.length} agent sessions${warning}`;
    this.statusBar.tooltip = new vscode.MarkdownString(
      ['**silykat: agent sessions of this workspace**', ...this.relevant.map(describe)].join('\n\n'),
      true,
    );
    this.statusBar.show();
  }

  private async show(): Promise<void> {
    await this.refresh();
    if (this.all.length === 0) {
      void vscode.window.showInformationMessage(
        'silykat: no agent session is running. Start one (e.g. `claude` with the silykat plugin) and it shows up here.',
      );
      return;
    }
    const relevant = new Set(this.relevant.map((s) => s.id));
    const sorted = [...this.all].sort((a, b) => Number(relevant.has(b.id)) - Number(relevant.has(a.id)));
    await vscode.window.showQuickPick(
      sorted.map((s) => ({
        label: `$(hubot) ${sessionLabel(s)}${s.push === false ? ' $(warning)' : ''}`,
        description: sessionTopics(s),
        detail: `${s.cwd} · session ${s.id}`,
      })),
      {
        title: 'Running agent sessions',
        placeHolder: 'Sessions registered with silykat, and what they are subscribed to',
      },
    );
  }
}

function describe(s: Session): string {
  const line = `**${sessionLabel(s)}** — subscribed to: ${sessionTopics(s)}`;
  if (s.push !== false) return line;
  const fix = s.pushCommand ? ` Relaunch it with \`${s.pushCommand}\`.` : '';
  return `${line}\n\n$(warning) Can't be notified of your comments: it sees them when you ask it.${fix}`;
}

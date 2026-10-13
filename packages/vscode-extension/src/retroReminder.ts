import * as vscode from 'vscode';
import {
  DEFAULT_CONFIG,
  readConfig,
  retroCadence,
  thresholdsOf,
  writeConfig,
  type MachineConfig,
  type RetroCadence,
} from '@silykat/core';
import {
  MIRRORED,
  RETRO_COMMAND,
  retroReminderMessage,
  retroStatusText,
  retroTooltip,
  shownCadence,
  validFor,
  type StatusBarMode,
} from './retroStatus';

const SECTION = 'silykat.retroReminder';
const POLL_MS = 2 * 60_000;
/** After comments change, or when the window gets the focus back: not more often than this. */
const SETTLE_MS = 10_000;

/** Shows a message with buttons; resolves to the button clicked. */
export type ReminderPrompt = (message: string, actions: string[]) => Thenable<string | undefined>;

/**
 * The retro reminder in the status bar: days and size of the review threads since the last retro of
 * each folder of the workspace, e.g. "Retro: 6 d · 640.0 KB", and "Retro due" once a threshold is
 * reached. A click explains how to run the retro.
 */
export class RetroReminderUi implements vscode.Disposable {
  private readonly statusBar = vscode.window.createStatusBarItem('silykat.retro', vscode.StatusBarAlignment.Left, 97);
  private readonly disposables: vscode.Disposable[] = [];
  private readonly timer: NodeJS.Timeout;
  private settle: NodeJS.Timeout | undefined;
  private lastRefresh = 0;
  private running: Promise<void> | undefined;
  cadences: RetroCadence[] = [];
  prompt: ReminderPrompt = (message, actions) => vscode.window.showInformationMessage(message, ...actions);

  constructor(onCommentsChanged: vscode.Event<void>) {
    this.statusBar.name = 'silykat: retro reminder';
    this.statusBar.command = 'silykat.showRetroReminder';
    this.disposables.push(
      vscode.commands.registerCommand('silykat.showRetroReminder', () => this.show()),
      onCommentsChanged(() => this.refreshSoon()),
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused && Date.now() - this.lastRefresh > SETTLE_MS) this.refreshSoon(0);
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refreshSoon(0)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration(SECTION)) return;
        void this.mirror((key) => e.affectsConfiguration(`${SECTION}.${key}`)).then(() => this.refresh());
      }),
    );
    this.timer = setInterval(() => void this.refresh(), POLL_MS);
    void this.mirror(() => true, true).then(() => this.refresh());
  }

  /** Status bar text, `undefined` when hidden. For tests. */
  get statusText(): string | undefined {
    return this.visible ? this.statusBar.text : undefined;
  }

  private visible = false;

  /** Measures again now (it is also done every few minutes, and when comments change). */
  refresh(): Promise<void> {
    // One at a time: a refresh asked meanwhile runs after it, with the latest settings.
    const next = (this.running ?? Promise.resolve()).then(() => this.measure());
    this.running = next.finally(() => {
      if (this.running === next) this.running = undefined;
    });
    return next;
  }

  dispose(): void {
    clearInterval(this.timer);
    clearTimeout(this.settle);
    this.disposables.forEach((d) => d.dispose());
    this.statusBar.dispose();
  }

  private refreshSoon(delay = SETTLE_MS): void {
    clearTimeout(this.settle);
    this.settle = setTimeout(() => void this.refresh(), delay);
  }

  private async measure(): Promise<void> {
    this.lastRefresh = Date.now();
    const thresholds = thresholdsOf(await this.settings());
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
    const measured = await Promise.all(
      folders.map((f) => retroCadence(f.uri.fsPath, { thresholds }).catch(() => null)),
    );
    this.cadences = measured.filter((c): c is RetroCadence => c !== null);
    this.render();
  }

  /**
   * The reminder settings in force: a value set in VS Code (user, workspace or folder settings),
   * else the machine setting (`slk config`), else the default.
   */
  async settings(): Promise<MachineConfig> {
    const machine = await readConfig();
    const config = vscode.workspace.getConfiguration(SECTION);
    const out = { ...machine };
    for (const [key, name] of Object.entries(MIRRORED)) {
      const i = config.inspect(key);
      const set = i?.workspaceFolderValue ?? i?.workspaceValue ?? i?.globalValue;
      if (set !== undefined && validFor(name, set)) Object.assign(out, { [name]: set });
    }
    return out;
  }

  /**
   * Writes the user's VS Code reminder settings to the machine settings, for the agent hooks: the
   * ones that changed (back to the default when reset), or at start the ones set and not mirrored yet.
   */
  private mirror(changed: (key: string) => boolean, atStart = false): Promise<void> {
    // One at a time: each compares with what the previous one wrote.
    const next = this.mirroring.then(() => this.mirrorNow(changed, atStart));
    this.mirroring = next.catch(() => undefined);
    return next;
  }

  private mirroring: Promise<void> = Promise.resolve();

  private async mirrorNow(changed: (key: string) => boolean, atStart: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration(SECTION);
    const machine = await readConfig();
    const change: Partial<MachineConfig> = {};
    for (const [key, name] of Object.entries(MIRRORED)) {
      if (!changed(key)) continue;
      const set = config.inspect(key)?.globalValue;
      if (atStart && set === undefined) continue;
      const value = set !== undefined && validFor(name, set) ? set : DEFAULT_CONFIG[name];
      if (machine[name] !== value) Object.assign(change, { [name]: value });
    }
    if (Object.keys(change).length > 0) await writeConfig(change).catch(() => undefined);
  }

  private render(): void {
    const mode = vscode.workspace.getConfiguration(SECTION).get<StatusBarMode>('statusBar', 'always');
    const c = shownCadence(this.cadences);
    const text = retroStatusText(c, mode);
    this.visible = text !== undefined;
    if (!c || text === undefined) {
      this.statusBar.hide();
      return;
    }
    this.statusBar.text = text;
    this.statusBar.backgroundColor = c.reasons.includes('max-days')
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
    this.statusBar.tooltip = new vscode.MarkdownString(retroTooltip(this.cadences, folderName), true);
    this.statusBar.show();
  }

  /** Explains where things stand and how to run a retro. Resolves to the message shown, for tests. */
  async show(): Promise<string> {
    await this.refresh();
    const c = shownCadence(this.cadences);
    const message = retroReminderMessage(c, thresholdsOf(await this.settings()), folderName);
    const copy = `Copy ${RETRO_COMMAND}`;
    const open = 'Reminder Settings';
    const choice = await this.prompt(message, c ? [copy, open] : [open]);
    if (choice === copy) await vscode.env.clipboard.writeText(RETRO_COMMAND);
    if (choice === open) await vscode.commands.executeCommand('workbench.action.openSettings', SECTION);
    return message;
  }
}

function folderName(c: RetroCadence): string {
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(c.root));
  return folder?.name ?? c.root;
}

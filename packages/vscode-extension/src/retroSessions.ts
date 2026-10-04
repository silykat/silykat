import * as vscode from 'vscode';
import { DEFAULT_CONFIG, SESSIONS_MODES, writeConfig, type SessionsMode } from '@local-review/core';
import type { Log } from './log';

const SECTION = 'localReview';
const SETTING = 'retroSessions';

/**
 * The "Retro Sessions" setting (how a retro reads the agent's sessions): mirrored in the machine
 * settings, which the retro reads through `lr`, outside VS Code. Written at start when set, and on
 * every change (back to the default when reset).
 */
export class RetroSessionsSetting implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  /** The last write, for tests. */
  written: Promise<void> = Promise.resolve();

  constructor(private readonly log: Log) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${SECTION}.${SETTING}`)) this.written = this.mirror();
      }),
    );
    this.written = this.mirror(true);
  }

  private async mirror(atStart = false): Promise<void> {
    const set = vscode.workspace.getConfiguration(SECTION).inspect<string>(SETTING)?.globalValue;
    const valid = SESSIONS_MODES.includes(set as SessionsMode);
    if (atStart && !valid) return;
    try {
      await writeConfig({ retroSessions: valid ? (set as SessionsMode) : DEFAULT_CONFIG.retroSessions });
    } catch (err) {
      this.log.warn('Could not write the retro-sessions machine setting', err);
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

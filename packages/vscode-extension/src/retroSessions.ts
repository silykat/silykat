import * as vscode from 'vscode';
import {
  DEFAULT_CONFIG,
  SESSIONS_MODES,
  SOURCE_KEY,
  SOURCE_SETTINGS,
  writeConfig,
  type MachineConfig,
} from '@local-review/core';
import type { Log } from './log';

const SECTION = 'localReview';

/** The retro settings of VS Code mirrored in the machine settings, with their valid values. */
const MIRRORED: readonly { setting: string; key: keyof MachineConfig; values: readonly string[] }[] = [
  { setting: 'retroSessions', key: 'retroSessions', values: SESSIONS_MODES },
  { setting: 'retroSources.reviews', key: SOURCE_KEY.reviews, values: SOURCE_SETTINGS },
  { setting: 'retroSources.sessions', key: SOURCE_KEY.sessions, values: SOURCE_SETTINGS },
  { setting: 'retroSources.audit', key: SOURCE_KEY.audit, values: SOURCE_SETTINGS },
];

/**
 * The retro settings of VS Code ("Retro Sessions": how a retro reads the agent's sessions; "Retro
 * Sources": whether it reads each source): mirrored in the machine settings, which the retro reads
 * through `lr`, outside VS Code. Written at start when set, and on every change (back to the default
 * when reset). A project's own settings (`lr config --project`) still come first.
 */
export class RetroSessionsSetting implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  /** The last write, for tests. */
  written: Promise<void> = Promise.resolve();

  constructor(private readonly log: Log) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        const changed = MIRRORED.filter((m) => e.affectsConfiguration(`${SECTION}.${m.setting}`));
        if (changed.length > 0) this.written = this.mirror(changed);
      }),
    );
    this.written = this.mirror(MIRRORED, true);
  }

  private async mirror(settings: typeof MIRRORED, atStart = false): Promise<void> {
    const config = vscode.workspace.getConfiguration(SECTION);
    const change: Partial<MachineConfig> = {};
    for (const m of settings) {
      const set = config.inspect<string>(m.setting)?.globalValue;
      const valid = set !== undefined && m.values.includes(set);
      if (atStart && !valid) continue;
      Object.assign(change, { [m.key]: valid ? set : DEFAULT_CONFIG[m.key] });
    }
    if (Object.keys(change).length === 0) return;
    try {
      await writeConfig(change);
    } catch (err) {
      this.log.warn('Could not write the retro machine settings', err);
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

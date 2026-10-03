import * as vscode from 'vscode';
import {
  eraseHistory,
  historyPlan,
  historySummary,
  LOOSE_ROOT,
  readConfig,
  writeConfig,
  type HistoryPlan,
} from '@local-review/core';
import type { Log } from './log';

const SECTION = 'localReview';
const SETTING = 'keepHistory';

/** Asks whether to erase the history already kept (`undefined` = dismissed). Replaceable in tests. */
export type ErasePrompt = (message: string, actions: string[]) => Thenable<string | undefined>;

/**
 * Whether the history of what is deleted is kept: the VS Code user setting, else the machine
 * setting (`lr config set keep-history`), on by default.
 */
export async function keepHistory(): Promise<boolean> {
  const set = vscode.workspace.getConfiguration(SECTION).inspect<boolean>(SETTING)?.globalValue;
  return typeof set === 'boolean' ? set : (await readConfig()).keepHistory;
}

/**
 * The "Keep history" setting: mirrored in the machine settings, for `lr` and the agent hooks, which
 * run outside VS Code. When the user turns it off, offers to erase the history already kept in the
 * open folders: deleted threads, and threads saved from worktrees.
 */
export class HistoryUi implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  prompt: ErasePrompt = (message, actions) => vscode.window.showWarningMessage(message, ...actions);
  /** The last offer to erase, once answered. For tests. */
  offered: Promise<number | undefined> = Promise.resolve(undefined);

  constructor(
    private readonly folders: () => string[],
    private readonly log: Log,
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${SECTION}.${SETTING}`)) void this.changed();
      }),
    );
    void this.mirror(true);
  }

  /**
   * Writes the user's setting to the machine settings: at start when set, and on every change (back
   * to on when reset). The writes run in order (`writeConfig`), so the last change wins.
   */
  private async mirror(atStart = false): Promise<void> {
    const set = vscode.workspace.getConfiguration(SECTION).inspect<boolean>(SETTING)?.globalValue;
    if (atStart && typeof set !== 'boolean') return;
    try {
      await writeConfig({ keepHistory: typeof set === 'boolean' ? set : true });
    } catch (err) {
      this.log.warn('Could not write the keep-history machine setting', err);
    }
  }

  private async changed(): Promise<void> {
    const set = vscode.workspace.getConfiguration(SECTION).inspect<boolean>(SETTING)?.globalValue;
    await this.mirror();
    if (set === false) this.offered = this.offerToErase();
  }

  /** The history kept in the open folders, and the offer to erase it. Returns how many threads were erased. */
  async offerToErase(): Promise<number | undefined> {
    let plan: HistoryPlan;
    try {
      plan = await historyPlan(this.folders().filter((f) => f !== LOOSE_ROOT));
    } catch (err) {
      this.log.warn('Could not measure the history kept', err);
      return undefined;
    }
    const summary = historySummary(plan.deleted.length, plan.saved.length);
    if (summary === null) return undefined;
    const choice = await this.prompt(
      `Local Review: deleted threads are no longer kept. The history already kept in your folders stays: ${summary}. ` +
        'Erase it for good? It is gone from the history and from retros.',
      ['Erase', 'Keep'],
    );
    if (choice !== 'Erase') return undefined;
    try {
      const erased = await eraseHistory(plan);
      void vscode.window.showInformationMessage(
        `Local Review: erased ${historySummary(erased.threads, erased.saved) ?? 'nothing'}.`,
      );
      return erased.threads;
    } catch (err) {
      this.log.error('Failed to erase the history', err);
      void vscode.window.showErrorMessage(`Local Review: the history could not be erased (${String(err)}).`);
      return undefined;
    }
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

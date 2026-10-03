import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import {
  archivedThreads,
  archiveThreads,
  dateArgLabel,
  historyJson,
  LOOSE_ROOT,
  parseDateArg,
  projectHistory,
  projectThreads,
  purgePlan,
  purgeThreads,
  resolvedBefore,
  retroReading,
  unarchiveThreads,
  type BatchResult,
  type ProjectThread,
} from '@local-review/core';
import { archiveConfirmation, dayOf, keptText, plural, purgeConfirmation, threadItemText } from './archiveText';
import type { ReviewController } from './controller';
import type { Log } from './log';

/** Asks for a date (`undefined` = Esc). Replaceable in tests. */
export type DatePrompt = (title: string, prompt: string) => Promise<string | undefined>;
/** Picks threads in a list (`undefined` = Esc). Replaceable in tests. */
export type ThreadPicker = (items: ThreadItem[], placeHolder: string) => Promise<ThreadItem[] | undefined>;
/** Asks where to save a file (`undefined` = Esc). Replaceable in tests. */
export type SaveLocation = (defaultUri: vscode.Uri) => Promise<vscode.Uri | undefined>;

export interface ThreadItem extends vscode.QuickPickItem {
  thread: ProjectThread;
}

/**
 * Managing the threads of the open folders: archive the resolved ones, bring archived ones back,
 * export everything, delete old threads for good. The same core functions as `lr archive`,
 * `lr unarchive`, `lr history --out` and `lr purge`, on the projects of the open folders (each
 * folder, its subfolders and its worktrees) and on the files outside them.
 */
export class ArchiveUi implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[];
  askDate: DatePrompt = (title, prompt) =>
    Promise.resolve(
      vscode.window.showInputBox({
        title,
        prompt,
        value: dayOf(new Date()),
        validateInput: (v) => (parseDateArg(v) ? undefined : 'A date (2026-10-01) or a number of days ago (30d)'),
      }),
    );
  pickThreads: ThreadPicker = (items, placeHolder) =>
    Promise.resolve(vscode.window.showQuickPick(items, { canPickMany: true, placeHolder, matchOnDetail: true }));
  askSaveLocation: SaveLocation = (defaultUri) =>
    Promise.resolve(vscode.window.showSaveDialog({ defaultUri, filters: { JSON: ['json'] } }));
  /** Shows the outcome of a command (an information message). Replaceable in tests. */
  inform: (message: string) => void = (message) => void vscode.window.showInformationMessage(message);

  constructor(
    private readonly review: ReviewController,
    private readonly log: Log,
  ) {
    this.disposables = [
      vscode.commands.registerCommand('localReview.archiveThread', (t: vscode.CommentThread) =>
        review.archiveThread(t),
      ),
      vscode.commands.registerCommand('localReview.archiveResolvedThreads', () => this.archiveResolved()),
      vscode.commands.registerCommand('localReview.showArchivedThreads', () => this.showArchived()),
      vscode.commands.registerCommand('localReview.exportThreads', () => this.exportThreads()),
      vscode.commands.registerCommand('localReview.deleteOldThreads', () => this.deleteOld()),
    ];
  }

  private threads(): Promise<ProjectThread[]> {
    return projectThreads(this.review.rootPaths());
  }

  /** Archives the resolved threads resolved before a date, after saying how many. */
  async archiveResolved(): Promise<BatchResult | undefined> {
    const text = await this.askDate(
      'Archive Resolved Threads',
      'Archive the threads resolved before this date (2026-10-01, or 30d for 30 days ago). They leave VS Code and stay in the history.',
    );
    const date = text === undefined ? null : parseDateArg(text);
    if (text === undefined || !date) return undefined;
    const selected = resolvedBefore(await this.threads(), date);
    const day = dateArgLabel(text, date);
    if (selected.length === 0) {
      this.inform(`Local Review: no resolved thread to archive before ${day}.`);
      return undefined;
    }
    const c = archiveConfirmation(selected.length, day);
    const ok = await this.review.confirm(c.message, c.detail, c.action);
    if (!ok) return undefined;
    return this.run('archive', selected, archiveThreads, (k) => `Local Review: ${plural(k, 'thread')} archived.`);
  }

  /** Lists the archived threads; the ones picked come back to VS Code. */
  async showArchived(): Promise<BatchResult | undefined> {
    const archived = archivedThreads(await this.threads());
    if (archived.length === 0) {
      this.inform('Local Review: no archived thread.');
      return undefined;
    }
    const picked = await this.pickThreads(
      archived.map((t) => itemOf(t)),
      `${plural(archived.length, 'archived thread')}: pick the ones to bring back (unarchive)`,
    );
    if (!picked || picked.length === 0) return undefined;
    return this.run(
      'unarchive',
      picked.map((p) => p.thread),
      unarchiveThreads,
      (k) => `Local Review: ${plural(k, 'thread')} unarchived.`,
    );
  }

  /**
   * Writes every thread of the open folders' projects, whatever their state, to a JSON file: one
   * history per project, as `lr history --format json` gives it.
   */
  async exportThreads(): Promise<vscode.Uri | undefined> {
    const roots = this.review.rootPaths();
    const folder = roots.find((r) => r !== LOOSE_ROOT);
    const defaultUri = vscode.Uri.file(join(folder ?? process.cwd(), `local-review-threads-${dayOf(new Date())}.json`));
    const target = await this.askSaveLocation(defaultUri);
    if (!target) return undefined;
    try {
      const histories = await Promise.all(roots.map((r) => projectHistory(r)));
      const projects = histories.filter((h) => h.threads > 0).map(historyJson);
      const n = projects.reduce((k, p) => k + p.summary.threads, 0);
      await writeFile(
        target.fsPath,
        JSON.stringify({ exportedAt: new Date().toISOString(), threads: n, projects }, null, 2) + '\n',
      );
      this.inform(`Local Review: ${plural(n, 'thread')} exported to ${target.fsPath}.`);
      return target;
    } catch (err) {
      this.log.error('Failed to export the threads', err);
      void vscode.window.showErrorMessage(`Local Review: the threads could not be exported (${String(err)}).`);
      return undefined;
    }
  }

  /** Deletes for good the finished threads with no activity since a date, after a confirmation that says how many. */
  async deleteOld(): Promise<BatchResult | undefined> {
    const text = await this.askDate(
      'Delete Old Threads Permanently',
      'Delete for good the finished threads (resolved, archived or deleted) with no activity since this date (2026-10-01, or 90d).',
    );
    const date = text === undefined ? null : parseDateArg(text);
    if (text === undefined || !date) return undefined;
    const folders = this.review.rootPaths().filter((r) => r !== LOOSE_ROOT);
    const plan = purgePlan(await this.threads(), date, await retroReading(folders));
    const since = dateArgLabel(text, date);
    if (plan.threads.length === 0) {
      this.inform(
        `Local Review: no finished thread without activity since ${since}: nothing to delete.${keptText(plan)}`,
      );
      return undefined;
    }
    const c = purgeConfirmation(plan, since);
    const ok = await this.review.confirm(c.message, c.detail, c.action);
    if (!ok) return undefined;
    return this.run(
      'delete',
      plan.threads,
      purgeThreads,
      (k) => `Local Review: ${plural(k, 'thread')} deleted permanently.`,
    );
  }

  private async run(
    what: string,
    threads: ProjectThread[],
    action: (t: ProjectThread[]) => Promise<BatchResult>,
    done: (n: number) => string,
  ): Promise<BatchResult | undefined> {
    try {
      const result = await action(threads);
      await this.review.refreshThreads(threads.map((t) => t.thread.id));
      for (const f of result.failed) this.log.warn(`Could not ${what} ${f.id}: ${f.error}`);
      this.inform(
        done(result.done.length) +
          (result.failed.length > 0 ? ` ${result.failed.length} failed (see the Local Review output).` : ''),
      );
      return result;
    } catch (err) {
      this.log.error(`Failed to ${what} threads`, err);
      void vscode.window.showErrorMessage(`Local Review: could not ${what} the threads (${String(err)}).`);
      return undefined;
    }
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

/** A thread in a list (see `threadItemText`). */
const itemOf = (t: ProjectThread): ThreadItem => ({ ...threadItemText(t.thread), thread: t });

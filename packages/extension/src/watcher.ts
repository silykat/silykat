import { basename } from 'node:path';
import * as vscode from 'vscode';
import { STORE_DIR, Store } from '@local-review/core';

const DEBOUNCE_MS = 100;

/**
 * Watches a store's thread journals, including writes made by other processes (the agent).
 * Calls `onThreadChanged` once per burst of events on the same journal.
 */
export function watchThreads(rootPath: string, onThreadChanged: (threadId: string) => void): vscode.Disposable {
  const pattern = new vscode.RelativePattern(vscode.Uri.file(rootPath), `${STORE_DIR}/threads/*.jsonl`);
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);
  const timers = new Map<string, NodeJS.Timeout>();

  const schedule = (uri: vscode.Uri) => {
    const threadId = Store.threadIdOf(basename(uri.fsPath));
    if (!threadId) return;
    clearTimeout(timers.get(threadId));
    timers.set(
      threadId,
      setTimeout(() => {
        timers.delete(threadId);
        onThreadChanged(threadId);
      }, DEBOUNCE_MS),
    );
  };

  const subscriptions = [watcher.onDidCreate(schedule), watcher.onDidChange(schedule), watcher.onDidDelete(schedule)];
  return new vscode.Disposable(() => {
    timers.forEach(clearTimeout);
    subscriptions.forEach((s) => s.dispose());
    watcher.dispose();
  });
}

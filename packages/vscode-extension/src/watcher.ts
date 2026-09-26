import { basename } from 'node:path';
import * as vscode from 'vscode';
import { STORE_DIR, Store } from '@local-review/core';

const DEBOUNCE_MS = 100;

export interface StoreListener {
  /** A thread journal changed. */
  onThread(threadId: string): void;
  /** A review journal changed (started, submitted…): draft states may have changed. */
  onReviews(): void;
}

/**
 * Watches a store's journals, including writes made by other processes (the agent).
 * Each callback runs once per burst of events on the same journal.
 */
export function watchStore(rootPath: string, listener: StoreListener): vscode.Disposable {
  const root = vscode.Uri.file(rootPath);
  const timers = new Map<string, NodeJS.Timeout>();
  const debounce = (key: string, run: () => void) => {
    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        run();
      }, DEBOUNCE_MS),
    );
  };

  const threads = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(root, `${STORE_DIR}/threads/*.jsonl`),
  );
  const onThreadFile = (uri: vscode.Uri) => {
    const threadId = Store.threadIdOf(basename(uri.fsPath));
    if (threadId) debounce(threadId, () => listener.onThread(threadId));
  };

  const reviews = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(root, `${STORE_DIR}/reviews/*.jsonl`),
  );
  const onReviewFile = () => debounce('reviews', () => listener.onReviews());

  const subscriptions = [
    threads.onDidCreate(onThreadFile),
    threads.onDidChange(onThreadFile),
    threads.onDidDelete(onThreadFile),
    reviews.onDidCreate(onReviewFile),
    reviews.onDidChange(onReviewFile),
    reviews.onDidDelete(onReviewFile),
  ];
  return new vscode.Disposable(() => {
    timers.forEach(clearTimeout);
    subscriptions.forEach((s) => s.dispose());
    threads.dispose();
    reviews.dispose();
  });
}

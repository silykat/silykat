import { watch, type FSWatcher } from 'node:fs';
import { basename, join } from 'node:path';
import * as vscode from 'vscode';
import { Store } from '@local-review/core';

const DEBOUNCE_MS = 100;

export interface StoreListener {
  /** A thread journal changed. */
  onThread(threadId: string): void;
  /** A review journal changed (started, submitted…): draft states may have changed. */
  onReviews(): void;
}

/**
 * Watches a store's journals, including writes made by other processes (the agent).
 * Each callback runs once per burst of events on the same journal. A store outside the
 * workspace (the machine store) is watched with Node's watcher: VS Code's is not reliable there.
 */
export function watchStore(
  storeDir: string,
  listener: StoreListener,
  opts: { outsideWorkspace?: boolean } = {},
): vscode.Disposable {
  if (opts.outsideWorkspace) return watchWithNode(storeDir, listener);
  const dir = vscode.Uri.file(storeDir);
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

  const threads = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, 'threads/*.jsonl'));
  const onThreadFile = (uri: vscode.Uri) => {
    const threadId = Store.threadIdOf(basename(uri.fsPath));
    if (threadId) debounce(threadId, () => listener.onThread(threadId));
  };

  const reviews = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, 'reviews/*.jsonl'));
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

function watchWithNode(storeDir: string, listener: StoreListener): vscode.Disposable {
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
  const watchers: FSWatcher[] = [];
  const on = (folder: string, onFile: (name: string) => void) => {
    try {
      const w = watch(join(storeDir, folder), (_event, name) => {
        if (name && name.endsWith('.jsonl')) onFile(name.toString());
      });
      w.on('error', () => w.close()); // e.g. the folder was removed
      watchers.push(w);
    } catch {
      // the folder does not exist: nothing to watch
    }
  };
  on('threads', (name) => {
    const threadId = Store.threadIdOf(basename(name));
    if (threadId) debounce(threadId, () => listener.onThread(threadId));
  });
  on('reviews', () => debounce('reviews', () => listener.onReviews()));
  return new vscode.Disposable(() => {
    timers.forEach(clearTimeout);
    watchers.forEach((w) => w.close());
  });
}

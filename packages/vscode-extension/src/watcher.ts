import { existsSync, readdirSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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
 * Watches a store's journals, including writes made by other processes (the agent). Each callback
 * runs once per burst of events on the same journal.
 *
 * Node's watcher, not VS Code's: on Linux, VS Code's misses some writes made by other processes
 * (verified in the integration tests). The store may not exist yet (nothing commented so far) or be
 * removed: the nearest existing folder is watched until its folders are back, and the journals
 * already there are read then, as the watch may have started after their first write.
 */
export function watchStore(storeDir: string, listener: StoreListener): vscode.Disposable {
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
  const onThreadFile = (name: string) => {
    const threadId = Store.threadIdOf(basename(name));
    if (threadId) debounce(threadId, () => listener.onThread(threadId));
  };
  const onReviewFile = () => debounce('reviews', () => listener.onReviews());

  const threadsDir = join(storeDir, 'threads');
  const reviewsDir = join(storeDir, 'reviews');
  const watchers = new Map<string, FSWatcher>();
  let disposed = false;

  const close = (dir: string) => {
    watchers.get(dir)?.close();
    watchers.delete(dir);
  };
  /** Watches `dir`; false when it does not exist. */
  const watchDir = (dir: string, onEvent: (name: string) => void): boolean => {
    if (watchers.has(dir)) return true;
    try {
      const w = watch(dir, (_event, name) => {
        if (!existsSync(dir)) {
          // The folder was removed: wait for it again.
          close(dir);
          arm();
          return;
        }
        onEvent(name?.toString() ?? '');
      });
      w.on('error', () => {
        close(dir);
        arm();
      });
      watchers.set(dir, w);
      return true;
    } catch {
      return false;
    }
  };
  /** Journals written before their folder was watched. */
  const readJournals = (dir: string, onFile: (name: string) => void) => {
    try {
      readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .forEach(onFile);
    } catch {
      // gone again: the next arm() handles it
    }
  };
  /** Watches a folder of journals; `catchUp`: also reads those already there. */
  const journals = (dir: string, onFile: (name: string) => void, catchUp: boolean): boolean => {
    const known = watchers.has(dir);
    const watched = watchDir(dir, (name) => {
      if (name.endsWith('.jsonl')) onFile(name);
    });
    if (watched && !known && catchUp) readJournals(dir, onFile);
    return watched;
  };
  /** The first time, the caller loads the store itself: only later folders are caught up. */
  function arm(first = false): void {
    if (disposed) return;
    const threads = journals(threadsDir, onThreadFile, !first);
    const reviews = journals(reviewsDir, onReviewFile, !first);
    if (threads && reviews) {
      close(storeDir);
      close(dirname(storeDir));
      return;
    }
    // A folder is missing: watch the store for it, or the folder that holds the store.
    if (watchDir(storeDir, () => arm())) close(dirname(storeDir));
    else watchDir(dirname(storeDir), (name) => name === basename(storeDir) && arm());
  }
  arm(true);

  return new vscode.Disposable(() => {
    disposed = true;
    timers.forEach(clearTimeout);
    watchers.forEach((w) => w.close());
    watchers.clear();
  });
}

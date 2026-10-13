import { readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Store } from '@silykat/core';

const DEBOUNCE_MS = 100;
/** A new watch is not active right away (macOS): what is written meanwhile is read after this delay. */
const SETTLE_MS = 500;

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
 * (verified in the integration tests). The store may not exist yet (nothing commented so far), or be
 * removed and created again: the folder that holds it is watched too, and the journals already in a
 * folder that appears are read, as its watch may start after their first write.
 */
export function watchStore(storeDir: string, listener: StoreListener): { dispose(): void } {
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
  const store = basename(storeDir);
  const watched = new Map<string, { watcher: FSWatcher; inode: number }>();
  const settles = new Set<NodeJS.Timeout>();
  let disposed = false;

  /** The folder's inode, or null when it does not exist. */
  const inodeOf = (dir: string): number | null => {
    try {
      return statSync(dir).ino;
    } catch {
      return null;
    }
  };
  /** Journals written before their folder was watched. */
  const readJournals = (dir: string, onFile: (name: string) => void) => {
    try {
      readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .forEach(onFile);
    } catch {
      // gone again: the next sync handles it
    }
  };
  /**
   * Watches `dir` if it exists, again when `renew` (it may have been created again: Linux often
   * gives the new folder the same inode). Returns true when it starts a new watch.
   */
  const follow = (dir: string, onEvent: (name: string) => void, renew = false): boolean => {
    const inode = inodeOf(dir);
    const current = watched.get(dir);
    if (current && current.inode === inode && !renew) return false;
    current?.watcher.close();
    watched.delete(dir);
    if (inode === null) return false;
    try {
      const watcher = watch(dir, (_event, name) => {
        if (inodeOf(dir) !== inode) sync(true, true);
        else onEvent(name?.toString() ?? '');
      });
      watcher.on('error', () => sync(true, true));
      watched.set(dir, { watcher, inode });
      return true;
    } catch {
      return false;
    }
  };
  const journals = (dir: string, onFile: (name: string) => void, catchUp: boolean, renew: boolean) => {
    const started = follow(
      dir,
      (name) => {
        if (name.endsWith('.jsonl')) onFile(name);
        else sync(true, true); // the folder itself (removed?)
      },
      renew,
    );
    if (!started) return;
    if (catchUp) readJournals(dir, onFile);
    const settle = setTimeout(() => {
      settles.delete(settle);
      if (!disposed) readJournals(dir, onFile);
    }, SETTLE_MS);
    settles.add(settle);
  };
  /**
   * Every level stays watched: the folder that holds the store (for the store), the store (for its
   * folders), its folders (for the journals). A removed folder does not always tell its watcher, so
   * an event about a folder watches the levels below it again (`renew`). The first time, the caller
   * loads the store itself: only the folders that appear later are caught up.
   */
  function sync(catchUp: boolean, renew = false): void {
    if (disposed) return;
    const parentStarted = follow(dirname(storeDir), (name) => {
      if (name === store) sync(true, true);
    });
    const storeStarted = follow(
      storeDir,
      (name) => {
        if (name === 'threads' || name === 'reviews') sync(true, true);
      },
      renew,
    );
    journals(threadsDir, onThreadFile, catchUp, renew);
    journals(reviewsDir, onReviewFile, catchUp, renew);
    // The store or its folders may appear before a new watch of the levels above is active: look
    // again once it is (the levels already watched are left as they are).
    if (parentStarted || storeStarted) {
      const settle = setTimeout(() => {
        settles.delete(settle);
        sync(true);
      }, SETTLE_MS);
      settles.add(settle);
    }
  }
  sync(false);

  return {
    dispose: () => {
      disposed = true;
      timers.forEach(clearTimeout);
      settles.forEach(clearTimeout);
      watched.forEach(({ watcher }) => watcher.close());
      watched.clear();
    },
  };
}

import { mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { localReviewHome, LOOSE_ROOT, looseStore, STORE_DIR, Store } from '@local-review/core';
import { git } from './git';

export interface Root {
  /** Store root, expressed in the same path space as the workspace folder (not realpath'd). */
  path: string;
  isGit: boolean;
  store: Store;
  /** The files outside any open folder: kept in the machine store, with their full path. */
  loose?: boolean;
}

/**
 * The store root of a workspace folder is its git top-level, or the folder itself.
 * git returns a realpath (e.g. /private/var/... on macOS) whereas VS Code documents use the
 * folder's own path, so the top-level is re-expressed relative to the folder.
 */
export async function discoverRoot(folderPath: string): Promise<Root> {
  const top = await git(['rev-parse', '--show-toplevel'], folderPath);
  let path = folderPath;
  if (top) {
    const folderReal = await realpath(folderPath).catch(() => folderPath);
    path = resolve(folderPath, relative(folderReal, top));
  }
  return { path, isGit: top !== null, store: new Store(path) };
}

export class Roots {
  private roots: Root[] = [];

  async init(folderPaths: readonly string[]): Promise<void> {
    const found = await Promise.all(folderPaths.map(discoverRoot));
    // Several workspace folders inside the same repository share one store.
    const unique = new Map(found.map((r) => [r.path, r]));
    // Last resort: a file in none of the open folders (e.g. written by an agent in a parent folder).
    // The most specific root always wins, so this one only gets such files.
    const loose: Root = { path: LOOSE_ROOT, isGit: false, store: looseStore(), loose: true };
    // Its folders exist from the start, so that it can be watched (agents write there too).
    await mkdir(join(loose.store.dir, 'threads'), { recursive: true }).catch(() => undefined);
    await mkdir(join(loose.store.dir, 'reviews'), { recursive: true }).catch(() => undefined);
    this.roots = [...unique.values(), loose];
  }

  all(): readonly Root[] {
    return this.roots;
  }

  /** Most specific root containing the file, or undefined. */
  forFile(fsPath: string): Root | undefined {
    let best: Root | undefined;
    for (const r of this.roots) {
      const rel = relative(r.path, fsPath);
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue;
      if (!best || r.path.length > best.path.length) best = r;
    }
    return best;
  }

  /** Files that can be commented: inside a root, but not inside the store itself. */
  isCommentable(fsPath: string): boolean {
    const root = this.forFile(fsPath);
    if (!root) return false;
    // Local Review's own machine folder (sessions, the machine store) is not reviewed code.
    const home = localReviewHome();
    if (root.loose && (fsPath === home || fsPath.startsWith(home + sep))) return false;
    const storeDir = join(root.path, STORE_DIR);
    return fsPath !== storeDir && !fsPath.startsWith(storeDir + sep);
  }

  /** Path stored in anchors: relative to the root, always `/`-separated. */
  static anchorPath(root: Root, fsPath: string): string {
    return relative(root.path, fsPath).split(sep).join('/');
  }
}

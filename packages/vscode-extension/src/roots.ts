import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { STORE_DIR, Store } from '@local-review/core';
import { git } from './git';

export interface Root {
  /** Store root, expressed in the same path space as the workspace folder (not realpath'd). */
  path: string;
  isGit: boolean;
  store: Store;
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
    this.roots = [...unique.values()];
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
    const storeDir = join(root.path, STORE_DIR);
    return fsPath !== storeDir && !fsPath.startsWith(storeDir + sep);
  }

  /** Path stored in anchors: relative to the root, always `/`-separated. */
  static anchorPath(root: Root, fsPath: string): string {
    return relative(root.path, fsPath).split(sep).join('/');
  }
}

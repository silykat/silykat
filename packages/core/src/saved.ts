import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Threads saved from a git worktree before it is removed (`git worktree remove` deletes the
 * worktree's `.silykat/` with it). They are copied to the store of the repository's main
 * worktree, in `saved/<slot>/` (one slot per store of the worktree): its `threads/` and `reviews/`
 * journals as they were, and `origin.json`, where they come from. Older versions of silykat
 * ignore this folder; the editor never shows these copies, the history and the retro read them.
 */
export const SAVED_DIR = 'saved';

export interface SavedOrigin {
  /** The worktree they were saved from (it may be gone). */
  worktree: string;
  /** The folder of the store saved: the worktree, or a folder in it. Anchors are relative to it. */
  root: string;
  /** The repository: its common git folder. */
  repo: string;
  /** The branch checked out in the worktree at the last save (`null` when detached). */
  branch: string | null;
  firstSavedAt: string;
  savedAt: string;
}

export interface SavedStore extends SavedOrigin {
  /** The folder of the copy: `<main>/.silykat/saved/<slot>/`. */
  dir: string;
}

/** The threads saved from worktrees into the store kept in `storeDir` (a `.silykat/` folder). */
export async function savedStores(storeDir: string): Promise<SavedStore[]> {
  let slots: string[];
  try {
    slots = (await readdir(join(storeDir, SAVED_DIR), { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  const found: SavedStore[] = [];
  for (const slot of slots) {
    const dir = join(storeDir, SAVED_DIR, slot);
    const origin = parseOrigin(await readFile(join(dir, 'origin.json'), 'utf8').catch(() => ''));
    if (origin) found.push({ ...origin, dir });
  }
  return found;
}

export function parseOrigin(text: string): SavedOrigin | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : null);
  const [worktree, root, repo, savedAt] = [str('worktree'), str('root'), str('repo'), str('savedAt')];
  if (!worktree || !root || !repo || !savedAt) return null;
  return { worktree, root, repo, branch: str('branch'), firstSavedAt: str('firstSavedAt') ?? savedAt, savedAt };
}

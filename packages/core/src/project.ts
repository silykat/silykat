import { execFile } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { findStoreRoot, isStoreRoot } from './agentView';
import { activeSince, countStates, type StateCounts, type ThreadHistory } from './history';
import { LOOSE_ROOT, storeAt } from './sessions';
import { STORE_DIR } from './types';

/**
 * How a store was found for a project: the project folder itself, a folder below it, the closest
 * store above it (when the folder has none, as the other `lr` commands do), or a git worktree of
 * a repository of the project, kept outside the folder (e.g. next to the repository).
 */
export type StoreOrigin = 'root' | 'below' | 'above' | 'worktree';

export interface ProjectStore {
  /** The folder holding the `.local-review/` store (`/` for the machine store of loose files). */
  root: string;
  origin: StoreOrigin;
}

/**
 * Folders never searched for stores: dependencies, build outputs, and macOS's application folders
 * (`~/Library` alone holds tens of thousands of folders). Hidden folders (`.git`, `.venv`…) are
 * skipped too; worktrees kept in one (e.g. `.claude/worktrees/`) are found through git.
 */
const SKIPPED = new Set([
  'node_modules',
  'dist',
  'out',
  'build',
  'target',
  'vendor',
  'coverage',
  '__pycache__',
  'venv',
  'Library',
  'Applications',
]);

/**
 * Every store of a project: its folder and the folders below it, and the git worktrees of the
 * repositories found there, even when they are kept outside the folder. When the folder itself
 * has no store, the closest one above it too. Each store comes once. `/` is the machine store of
 * the files outside any open folder, alone.
 */
export async function projectStores(
  root: string,
  env: Record<string, string | undefined> = process.env,
): Promise<ProjectStore[]> {
  if (root === LOOSE_ROOT) return [{ root, origin: 'root' }];
  const top = resolve(root);
  const found: ProjectStore[] = [];
  const seen = new Set<string>();
  const add = async (dir: string, origin: StoreOrigin) => {
    const key = await realpath(join(dir, STORE_DIR)).catch(() => join(dir, STORE_DIR));
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ root: dir, origin });
  };

  const repos: string[] = [];
  const below: string[] = [];
  await walk(top, env, below, repos);
  for (const dir of below) await add(dir, dir === top ? 'root' : 'below');
  if (!below.includes(top)) {
    const above = findStoreRoot(top, env);
    if (above) {
      await add(above, 'above');
      repos.push(above);
    }
  }

  const realTop = await realpath(top).catch(() => top);
  const worktrees = new Set<string>();
  for (const list of await Promise.all(repos.map(worktreesOf)))
    for (const wt of list) if (!walked(realTop, wt)) worktrees.add(wt);
  for (const wt of [...worktrees].sort()) {
    const stores: string[] = [];
    await walk(wt, env, stores, []);
    for (const dir of stores) await add(dir, 'worktree');
  }

  const order: Record<StoreOrigin, number> = { root: 0, below: 1, above: 2, worktree: 3 };
  return found.sort((a, b) => order[a.origin] - order[b.origin] || a.root.localeCompare(b.root));
}

/** Whether the walk from `top` went through `dir`: inside it, and through no skipped folder. */
function walked(top: string, dir: string): boolean {
  const rel = relative(top, dir);
  if (rel === '') return true;
  if (rel.startsWith('..') || isAbsolute(rel)) return false;
  return rel.split(sep).every((part) => !part.startsWith('.') && !SKIPPED.has(part));
}

/** Stores (and git repositories: folders holding a `.git`) at and below `dir`. */
async function walk(
  dir: string,
  env: Record<string, string | undefined>,
  stores: string[],
  repos: string[],
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // gone, or not readable
  }
  if (entries.some((e) => e.name === '.git')) repos.push(dir);
  if (entries.some((e) => e.name === STORE_DIR && e.isDirectory()) && isStoreRoot(dir, env)) stores.push(dir);
  const children = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIPPED.has(e.name));
  await Promise.all(children.map((e) => walk(join(dir, e.name), env, stores, repos)));
}

/** The worktrees of the git repository of `dir` (their real paths); none outside git. */
function worktreesOf(dir: string): Promise<string[]> {
  return new Promise((done) =>
    execFile('git', ['worktree', 'list', '--porcelain'], { cwd: dir, timeout: 3000 }, (err, stdout) => {
      if (err) return done([]);
      const paths = stdout
        .split('\n')
        .filter((l) => l.startsWith('worktree '))
        .map((l) => l.slice('worktree '.length));
      void Promise.all(paths.map((p) => realpath(p).catch(() => null))).then((real) =>
        done(real.filter((p): p is string => p !== null)),
      );
    }),
  );
}

export interface StoreHistory extends ProjectStore {
  /** The threads of the period, oldest first. */
  threads: ThreadHistory[];
  /** Size of their journals, in bytes. */
  bytes: number;
  states: StateCounts;
  warnings: string[];
}

export interface ProjectHistory {
  root: string;
  /** Start of the period (ISO), `null` for the whole history. */
  since: string | null;
  stores: StoreHistory[];
  threads: number;
  bytes: number;
  states: StateCounts;
}

/**
 * The history of a project (see `projectStores`): every thread, whatever its state, with
 * published activity since `since` (the whole history without it).
 */
export async function projectHistory(
  root: string,
  opts: { since?: Date | null; env?: Record<string, string | undefined> } = {},
): Promise<ProjectHistory> {
  const env = opts.env ?? process.env;
  const sinceMs = opts.since ? opts.since.getTime() : null;
  const stores = await Promise.all(
    (await projectStores(root, env)).map(async (s): Promise<StoreHistory> => {
      const { threads, warnings } = await storeAt(s.root, env).loadHistory();
      const kept = threads
        .filter((t) => activeSince(t, sinceMs))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      return {
        ...s,
        threads: kept,
        bytes: kept.reduce((n, t) => n + t.bytes, 0),
        states: countStates(kept),
        warnings,
      };
    }),
  );
  const all = stores.flatMap((s) => s.threads);
  return {
    root: root === LOOSE_ROOT ? root : resolve(root),
    since: opts.since ? opts.since.toISOString() : null,
    stores,
    threads: all.length,
    bytes: stores.reduce((n, s) => n + s.bytes, 0),
    states: countStates(all),
  };
}

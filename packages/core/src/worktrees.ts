import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { storesUnder } from './project';
import { prepareStoreHome } from './storeHome';
import { parseOrigin, SAVED_DIR, type SavedOrigin } from './saved';
import { Store } from './store';
import { STORE_DIR } from './types';

function git(args: string[], cwd: string): Promise<string | null> {
  return new Promise((done) =>
    execFile('git', args, { cwd, timeout: 3000 }, (err, stdout) => done(err ? null : stdout.trim())),
  );
}

const real = (p: string) => realpath(p).catch(() => resolve(p));

/** Where a folder stands in git: its worktree, whether it is a linked one, and the main one. */
export interface WorktreeInfo {
  /** The top of the worktree holding the folder (its real path). */
  worktree: string;
  /** The repository: its common git folder (real path). */
  repo: string;
  /** A linked worktree (`git worktree add`), which `git worktree remove` deletes; not the main one. */
  linked: boolean;
  /** The main worktree of the repository; `null` for a bare repository. */
  main: string | null;
  /** The branch checked out; `null` when detached. */
  branch: string | null;
}

/** `null` outside git. */
export async function worktreeInfo(dir: string): Promise<WorktreeInfo | null> {
  const out = await git(
    ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel'],
    dir,
  );
  const [gitDir, commonDir, top] = out?.split('\n') ?? [];
  if (!gitDir || !commonDir || !top) return null;
  const [realGit, repo, worktree] = await Promise.all([real(gitDir), real(commonDir), real(top)]);
  const list = (await git(['worktree', 'list', '--porcelain'], dir)) ?? '';
  const first = list.split('\n\n')[0]?.split('\n') ?? [];
  const mainPath = first.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
  const main = mainPath && !first.includes('bare') ? await real(mainPath) : null;
  const branch = (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], dir)) || null;
  return { worktree, repo, linked: realGit !== repo, main, branch };
}

/** The worktrees of the repository of `dir` (their real paths). */
async function worktreesOf(dir: string): Promise<string[]> {
  const out = (await git(['worktree', 'list', '--porcelain'], dir)) ?? '';
  const paths = out
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length));
  return Promise.all(paths.map(real));
}

export const expandHome = (p: string, env: Record<string, string | undefined> = process.env): string =>
  p === '~' ? env.HOME || homedir() : p.startsWith('~/') ? join(env.HOME || homedir(), p.slice(2)) : p;

/**
 * The worktree a `git worktree remove <spec>` run in `cwd` means: a path, or (as git allows) the
 * last components of a worktree's path when they are unique. `null` when none matches.
 */
export async function resolveWorktree(cwd: string, spec: string): Promise<string | null> {
  const path = resolve(cwd, expandHome(spec));
  if (await stat(path).catch(() => null)) return real(path);
  const tail = sep + spec.replace(/[/\\]+$/, '').replace(/\//g, sep);
  const matches = (await worktreesOf(cwd)).filter((wt) => wt.endsWith(tail));
  return matches.length === 1 ? matches[0]! : null;
}

export interface SavedCopy {
  /** The store saved: the worktree, or a folder in it. */
  from: string;
  /** Where its copy is. */
  dir: string;
  /** Thread journals copied. */
  threads: number;
  /** Threads with published comments (those the history shows; the others only hold drafts). */
  published: number;
}

export interface WorktreeSave {
  worktree: string;
  branch: string | null;
  /** The main worktree, whose store holds the copies. */
  main: string;
  copies: SavedCopy[];
  threads: number;
  published: number;
}

/** A slot per store saved: readable, and unique to its folder. */
function slotOf(storeRoot: string): string {
  const name =
    basename(storeRoot)
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .slice(0, 60) || 'worktree';
  return `${name}-${createHash('sha256').update(storeRoot).digest('hex').slice(0, 8)}`;
}

/**
 * Saves the threads of the git worktree holding `dir` to the store of the repository's main
 * worktree, so that they outlive the worktree (`git worktree remove` deletes its `.local-review/`).
 * Their journals are copied as they are, with where they come from; saving again refreshes the
 * copy. Nothing is removed from the worktree. Throws outside a linked worktree.
 */
export async function saveWorktreeThreads(
  dir: string,
  env: Record<string, string | undefined> = process.env,
): Promise<WorktreeSave> {
  const info = await worktreeInfo(dir);
  if (!info) throw new Error(`${dir} is not in a git repository`);
  if (!info.linked)
    throw new Error(
      `${info.worktree} is the main worktree of its repository, not a linked one: git worktree remove never deletes it, so its comments are safe`,
    );
  if (!info.main) throw new Error(`the repository of ${info.worktree} has no main worktree (bare): nowhere to save`);
  const result: WorktreeSave = {
    worktree: info.worktree,
    branch: info.branch,
    main: info.main,
    copies: [],
    threads: 0,
    published: 0,
  };
  const stores = await storesUnder(info.worktree, env);
  if (stores.length === 0) return result;

  await prepareStoreHome(info.main);
  const mainStore = new Store(info.main);
  await mainStore.ensureInitialized();
  const now = new Date().toISOString();
  for (const root of stores) {
    const from = await real(root);
    const target = join(mainStore.dir, SAVED_DIR, slotOf(from));
    let threads = 0;
    for (const kind of ['threads', 'reviews']) {
      const files = await readdir(join(from, STORE_DIR, kind)).catch(() => [] as string[]);
      const journals = files.filter((f) => (kind === 'threads' ? Store.threadIdOf(f) !== null : f.endsWith('.jsonl')));
      if (journals.length === 0) continue;
      await mkdir(join(target, kind), { recursive: true });
      for (const f of journals) await copyFile(join(from, STORE_DIR, kind, f), join(target, kind, f));
      if (kind === 'threads') threads = journals.length;
    }
    if (threads === 0) continue;
    const previous = parseOrigin(await readFile(join(target, 'origin.json'), 'utf8').catch(() => ''));
    const origin: SavedOrigin & { v: number } = {
      v: 1,
      worktree: info.worktree,
      root: from,
      repo: info.repo,
      branch: info.branch,
      firstSavedAt: previous?.firstSavedAt ?? now,
      savedAt: now,
    };
    const tmp = join(target, `origin.json.${process.pid}.tmp`);
    await writeFile(tmp, JSON.stringify(origin, null, 2) + '\n');
    await rename(tmp, join(target, 'origin.json'));
    const published = (await new Store(from, target).loadHistory()).threads.length;
    result.copies.push({ from, dir: target, threads, published });
    result.threads += threads;
    result.published += published;
  }
  return result;
}

/** How many threads (with published comments) the stores of the worktree of `dir` hold. */
export async function worktreeThreadCount(
  dir: string,
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  let n = 0;
  for (const root of await storesUnder(dir, env)) n += (await new Store(root).loadHistory()).threads.length;
  return n;
}

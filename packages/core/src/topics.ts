import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';

/**
 * What a session subscribes to, and what a comment is published to: a branch of a git repository
 * (the files of the worktree that has it checked out), or a path outside git (a file or a folder).
 */
export type Topic =
  | {
      kind: 'branch';
      /** The repository: its common git folder, shared by all its worktrees. */
      repo: string;
      branch: string;
      /** Where that branch was checked out when this was written: for display and relevance only. */
      worktree?: string;
    }
  | { kind: 'path'; path: string };

/** Identity of a topic: two topics with the same key are the same. */
export const topicKey = (t: Topic): string => (t.kind === 'branch' ? `branch:${t.repo}#${t.branch}` : `path:${t.path}`);

/** Short name for people, e.g. "therapy · feature-x", or the path outside git. */
export function topicLabel(t: Topic): string {
  if (t.kind === 'path') return t.path;
  const repoName = basename(t.repo) === '.git' ? basename(dirname(t.repo)) : basename(t.repo).replace(/\.git$/, '');
  return `${repoName} · ${t.branch}`;
}

/** Whether `inner` is `outer` itself or inside it. */
export function isWithin(inner: string, outer: string): boolean {
  const rel = relative(outer, inner);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Whether a subscription to `subscribed` covers a file whose own topic is `file` (at `path`): the
 * same branch, or a path subscription to that file or to a folder holding it.
 */
export function topicCovers(subscribed: Topic, file: Topic, path: string): boolean {
  if (subscribed.kind === 'path') return isWithin(path, subscribed.path);
  return file.kind === 'branch' && topicKey(file) === topicKey(subscribed);
}

function git(args: string[], cwd: string, raw = false): Promise<string | null> {
  return new Promise((done) =>
    execFile('git', args, { cwd, timeout: 3000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
      done(err ? null : raw ? stdout : stdout.trim()),
    ),
  );
}

/** The closest existing folder of a path (a file may not exist yet, or any more). */
async function existingDir(path: string): Promise<string> {
  let dir = path;
  for (;;) {
    const s = await stat(dir).catch(() => null);
    if (s) return s.isDirectory() ? dir : dirname(dir);
    const parent = dirname(dir);
    if (parent === dir) return dir;
    dir = parent;
  }
}

/** The git worktree holding `dir`, with its branch; `null` outside git or without a branch (e.g. mid-rebase). */
export async function gitWorktreeOf(dir: string): Promise<{ repo: string; branch: string; worktree: string } | null> {
  const out = await git(['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'], dir);
  if (!out) return null;
  const [commonDir, worktree] = out.split('\n');
  if (!commonDir || !worktree) return null;
  const branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], dir);
  if (!branch) return null;
  return { repo: await realpath(commonDir).catch(() => commonDir), branch, worktree };
}

/**
 * The topic of a file (or folder): the branch of its git worktree, else the path itself. With
 * `asPath`, always the path (e.g. "subscribe to this folder" inside a repository).
 */
export async function topicOf(path: string, opts: { asPath?: boolean } = {}): Promise<Topic> {
  if (!opts.asPath) {
    const wt = await gitWorktreeOf(await existingDir(path));
    if (wt) return { kind: 'branch', ...wt };
  }
  return { kind: 'path', path };
}

/**
 * Files of the git worktree of `dir` that git sees as changed or new, and whose content changed
 * since `sinceMs` (a second of slack for coarse file times). Nothing outside git.
 */
export async function filesChangedSince(dir: string, sinceMs: number): Promise<string[]> {
  const top = await git(['rev-parse', '--show-toplevel'], dir);
  const status = top ? await git(['status', '--porcelain', '-z'], dir, true) : null;
  if (!top || !status) return [];
  // Entries are "XY path", NUL-separated; a rename or copy is followed by its original path.
  const entries = status.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.length < 4) continue;
    if (entry[0] === 'R' || entry[0] === 'C') i++;
    if (entry[1] !== 'D' && entry[0] !== 'D') paths.push(join(top, entry.slice(3)));
  }
  const recent = await Promise.all(
    paths.map(async (p) => ((await stat(p).catch(() => null))?.mtimeMs ?? 0) >= sinceMs - 1000),
  );
  return paths.filter((_, i) => recent[i]);
}

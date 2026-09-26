import { execFile } from 'node:child_process';
import { mkdir, readFile, appendFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { STORE_DIR } from '@local-review/core';

/** Runs git and returns trimmed stdout, or `null` if git is missing or the command fails. */
export function git(args: string[], cwd: string): Promise<string | null> {
  return new Promise((done) => {
    execFile('git', args, { cwd, timeout: 5000 }, (err, stdout) => done(err ? null : stdout.trim()));
  });
}

/** Full sha of the commit a ref points to, or `null` if it cannot be resolved. */
export async function resolveCommit(cwd: string, ref: string): Promise<string | null> {
  const sha = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
  return sha && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

/** Whether a commit is still in the repository (it may be gone after a rebase and a gc). */
export async function commitExists(cwd: string, sha: string): Promise<boolean> {
  return (await git(['cat-file', '-e', `${sha}^{commit}`], cwd)) !== null;
}

/**
 * Where a file went if git saw it renamed or moved: in uncommitted changes (staged or not), then
 * in recent history. Follows successive renames. Paths are relative to the repository root, `/`-separated.
 */
export async function findRename(repoRoot: string, path: string): Promise<string | null> {
  const [uncommitted, history] = await Promise.all([
    git(['diff', '-M', '--name-status', 'HEAD'], repoRoot),
    git(['log', '-M', '--diff-filter=R', '--name-status', '--format=', '-n', '500'], repoRoot),
  ]);
  // Newest first: uncommitted renames, then the log (which lists the most recent commits first).
  const renames = new Map<string, string>();
  for (const line of `${uncommitted ?? ''}\n${history ?? ''}`.split('\n')) {
    const [status, from, to] = line.split('\t');
    if (status?.startsWith('R') && from && to && !renames.has(from)) renames.set(from, to);
  }
  let current = path;
  for (let hops = 0; hops < 20 && renames.has(current); hops++) current = renames.get(current)!;
  return current === path ? null : current;
}

export async function gitUserName(cwd: string): Promise<string | null> {
  const name = await git(['config', 'user.name'], cwd);
  return name || null;
}

const EXCLUDE_ENTRY = `/${STORE_DIR}/`;
const ACCEPTED = new Set([EXCLUDE_ENTRY, `${STORE_DIR}/`, `/${STORE_DIR}`, STORE_DIR]);

/**
 * Adds the store directory to the repository's local exclude file (never `.gitignore`).
 * Uses `--git-path` so it also works in linked worktrees. Returns true if the file was changed.
 */
export async function ensureExcluded(repoRoot: string): Promise<boolean> {
  const rel = await git(['rev-parse', '--git-path', 'info/exclude'], repoRoot);
  if (!rel) return false;
  const file = resolve(repoRoot, rel);

  let content = '';
  try {
    content = await readFile(file, 'utf8');
  } catch {
    // Missing exclude file: created below.
  }
  if (content.split(/\r?\n/).some((line) => ACCEPTED.has(line.trim()))) return false;

  await mkdir(dirname(file), { recursive: true });
  const prefix = content === '' || content.endsWith('\n') ? '' : '\n';
  await appendFile(file, `${prefix}# local-review (VS Code extension)\n${EXCLUDE_ENTRY}\n`);
  return true;
}

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

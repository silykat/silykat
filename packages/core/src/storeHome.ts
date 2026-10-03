import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { STORE_DIR } from './types';

/**
 * Before `.local-review/` is created at the top of a git worktree (by a retro, or to save the
 * threads of another worktree), git is told to ignore it, as the editor does for comments (they are
 * the user's, never committed).
 */
export async function prepareStoreHome(home: string): Promise<void> {
  const store = join(home, STORE_DIR);
  if (await stat(store).catch(() => null)) return;
  const exclude = await new Promise<string | null>((done) =>
    execFile('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: home, timeout: 3000 }, (err, out) =>
      done(err ? null : out.trim()),
    ),
  );
  if (exclude) {
    const file = isAbsolute(exclude) ? exclude : join(home, exclude);
    const current = await readFile(file, 'utf8').catch(() => '');
    const accepted = [`${STORE_DIR}/`, STORE_DIR, `/${STORE_DIR}/`, `/${STORE_DIR}`];
    if (!current.split('\n').some((l) => accepted.includes(l.trim()))) {
      await mkdir(join(file, '..'), { recursive: true });
      await appendFile(file, `${current === '' || current.endsWith('\n') ? '' : '\n'}${STORE_DIR}/\n`);
    }
  }
  await mkdir(store, { recursive: true });
}

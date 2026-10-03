import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { worktreeTopOf } from './topics';

/**
 * The key of Jev, the optional classification service of the retro. It is kept in a file only the
 * user can read, outside any repository, and is never read here: only checked. `JEV_API_KEY` is
 * accepted too, for those who prefer an environment variable.
 */
export function jevKeyFile(env: Record<string, string | undefined> = process.env): string {
  return join(env.HOME?.trim() || homedir(), '.config', 'local-review', 'jev-key');
}

export interface KeyStatus {
  /** Where the key would come from: the environment, the file, or nowhere. */
  source: 'env' | 'file' | 'none';
  path: string;
  exists: boolean;
  /** Permissions of the file, in octal (e.g. `600`). */
  mode: string | null;
  /** Only its owner can read or write it, and the owner is the current user. */
  private: boolean;
  /** The repository holding the file, if it is in one. */
  inRepo: string | null;
  /** The key can be used. */
  ok: boolean;
  /** What to run to fix it. */
  fixes: string[];
}

/** Checks the key file without reading it. */
export async function jevKeyStatus(env: Record<string, string | undefined> = process.env): Promise<KeyStatus> {
  const path = jevKeyFile(env);
  const fromEnv = (env.JEV_API_KEY ?? '').trim() !== '';
  const st = await stat(path).catch(() => null);
  const exists = st?.isFile() === true;
  const status: KeyStatus = {
    source: fromEnv ? 'env' : exists ? 'file' : 'none',
    path,
    exists,
    mode: null,
    private: false,
    inRepo: null,
    ok: fromEnv,
    fixes: [],
  };
  if (!exists || !st) return status;
  status.mode = (st.mode & 0o777).toString(8);
  const mine = typeof process.getuid !== 'function' || st.uid === process.getuid();
  status.private = (st.mode & 0o077) === 0 && mine;
  status.inRepo = await worktreeTopOf(dirname(path));
  if (!status.private) status.fixes.push(`chmod 600 "${path}"`);
  if (status.inRepo)
    status.fixes.push(`move it out of the repository ${status.inRepo} (e.g. to the default place, ${jevKeyFile(env)})`);
  if (!fromEnv) status.ok = status.private && status.inRepo === null;
  return status;
}

/**
 * A command the user runs in their own terminal (never through the agent: the key must not go
 * through the conversation). It asks for the key without showing it, and saves it in a file only
 * they can read.
 */
export function jevKeySetupCommand(path = '$HOME/.config/local-review/jev-key'): string {
  const dir = path.replace(/\/[^/]+$/, '');
  return (
    `sh -c 'umask 077 && mkdir -p "${dir}" && trap "stty echo; echo; exit 130" INT TERM && ` +
    `printf "Jev API key (hidden): " && stty -echo && ` +
    `IFS= read -r k; stty echo; echo; [ -n "$k" ] && : > "${path}" && chmod 600 "${path}" && ` +
    `printf "%s\\n" "$k" > "${path}" && echo "Saved in ${path}"'`
  );
}

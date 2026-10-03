import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { localReviewHome } from './sessions';

/**
 * Settings of Local Review on this machine, in `<home>/config.json`: read by the agent hooks, which
 * run outside the editor. A missing file, or a missing setting, means the default.
 */
export interface MachineConfig {
  /**
   * Before an agent removes a git worktree that has comments (`git worktree remove`…), its hook
   * saves the worktree's threads to the main repository's store. On by default: it only copies.
   */
  autoSaveWorktrees: boolean;
}

export const DEFAULT_CONFIG: MachineConfig = { autoSaveWorktrees: true };

/** The settings as `lr config` names them, with how to read a value given on the command line. */
export const CONFIG_KEYS: Record<string, { key: keyof MachineConfig; help: string }> = {
  'auto-save-worktrees': {
    key: 'autoSaveWorktrees',
    help: "on|off — before an agent removes a git worktree, its hook saves the worktree's threads (default: on)",
  },
};

export const configFile = (env: Record<string, string | undefined> = process.env): string =>
  join(localReviewHome(env), 'config.json');

/** The machine settings; an unreadable file gives the defaults (a hook must never fail on it). */
export async function readConfig(env: Record<string, string | undefined> = process.env): Promise<MachineConfig> {
  const config = { ...DEFAULT_CONFIG };
  try {
    const raw: unknown = JSON.parse(await readFile(configFile(env), 'utf8'));
    if (typeof raw === 'object' && raw !== null && typeof (raw as MachineConfig).autoSaveWorktrees === 'boolean')
      config.autoSaveWorktrees = (raw as MachineConfig).autoSaveWorktrees;
  } catch {
    // missing or invalid: the defaults
  }
  return config;
}

/** Changes settings, keeping the others (and unknown keys written by a newer version). Written atomically. */
export async function writeConfig(
  change: Partial<MachineConfig>,
  env: Record<string, string | undefined> = process.env,
): Promise<MachineConfig> {
  const file = configFile(env);
  let current: Record<string, unknown> = {};
  try {
    const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) current = raw as Record<string, unknown>;
  } catch {
    // missing or invalid: start again
  }
  const next = { ...current, ...change };
  await mkdir(localReviewHome(env), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2) + '\n');
  await rename(tmp, file);
  return readConfig(env);
}

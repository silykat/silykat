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
  /** When a retro is due, the agent says so once at the start of a session. */
  retroReminder: boolean;
  /** A retro is due this many days after the last one… */
  retroReminderDays: number;
  /** …or sooner, once the threads since the last one weigh this many kilobytes (1 KB = 1,000 bytes)… */
  retroReminderSizeKB: number;
  /** …and never later than this many days, whatever the other settings: agents delete their conversations after a while. */
  retroReminderMaxDays: number;
}

export const DEFAULT_CONFIG: MachineConfig = {
  autoSaveWorktrees: true,
  retroReminder: true,
  retroReminderDays: 7,
  retroReminderSizeKB: 1000,
  retroReminderMaxDays: 25,
};

type BooleanKey = { [K in keyof MachineConfig]: MachineConfig[K] extends boolean ? K : never }[keyof MachineConfig];
type NumberKey = { [K in keyof MachineConfig]: MachineConfig[K] extends number ? K : never }[keyof MachineConfig];

export type ConfigSetting =
  { key: BooleanKey; kind: 'boolean'; help: string } | { key: NumberKey; kind: 'number'; help: string };

/** The settings as `lr config` names them, with how to read a value given on the command line. */
export const CONFIG_KEYS: Record<string, ConfigSetting> = {
  'auto-save-worktrees': {
    key: 'autoSaveWorktrees',
    kind: 'boolean',
    help: "on|off — before an agent removes a git worktree, its hook saves the worktree's threads (default: on)",
  },
  'retro-reminder': {
    key: 'retroReminder',
    kind: 'boolean',
    help: 'on|off — when a retro is due, the agent says so at the start of a session (default: on)',
  },
  'retro-reminder-days': {
    key: 'retroReminderDays',
    kind: 'number',
    help: 'days — a retro is due this many days after the last one (default: 7)',
  },
  'retro-reminder-size': {
    key: 'retroReminderSizeKB',
    kind: 'number',
    help: 'KB — or sooner, once the threads since the last one weigh this much (default: 1000, i.e. 1 MB)',
  },
  'retro-reminder-max-days': {
    key: 'retroReminderMaxDays',
    kind: 'number',
    help: 'days — and never later than this, to keep the agent conversations linked to replies (default: 25)',
  },
};

export const configFile = (env: Record<string, string | undefined> = process.env): string =>
  join(localReviewHome(env), 'config.json');

/** A number of days or kilobytes, as a setting takes it: a whole number, 1 or more. */
export const validSettingNumber = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 1;

/** The machine settings; an unreadable file gives the defaults (a hook must never fail on it). */
export async function readConfig(env: Record<string, string | undefined> = process.env): Promise<MachineConfig> {
  const config = { ...DEFAULT_CONFIG };
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(configFile(env), 'utf8'));
  } catch {
    return config; // missing or invalid: the defaults
  }
  if (typeof raw !== 'object' || raw === null) return config;
  const values = raw as Record<string, unknown>;
  for (const setting of Object.values(CONFIG_KEYS)) {
    const value = values[setting.key];
    // A value of the wrong type (edited by hand) is ignored: the default stays.
    if (setting.kind === 'boolean' && typeof value === 'boolean') config[setting.key] = value;
    if (setting.kind === 'number' && validSettingNumber(value)) config[setting.key] = value;
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
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2) + '\n');
  await rename(tmp, file);
  return readConfig(env);
}

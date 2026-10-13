import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { silykatHome } from './sessions';
import { STORE_DIR } from './types';

/**
 * Settings of silykat on this machine, in `<home>/config.json`: read by the agent hooks, which
 * run outside the editor. A missing file, or a missing setting, means the default.
 */
export interface MachineConfig {
  /**
   * Keep the history of what is deleted, for `slk review history` and retros (on by default): a deleted
   * thread stays in its journal, and before an agent removes a git worktree that has comments, its
   * hook saves the worktree's threads to the main repository's store. Off, deleting a thread erases
   * its journals, and nothing is saved when a worktree is removed.
   */
  keepHistory: boolean;
  /** When a retro is due, the agent says so once at the start of a session. */
  retroReminder: boolean;
  /** A retro is due this many days after the last one… */
  retroReminderDays: number;
  /** …or sooner, once the threads since the last one weigh this many kilobytes (1 KB = 1,000 bytes)… */
  retroReminderSizeKB: number;
  /** …and never later than this many days, whatever the other settings: agents delete their conversations after a while. */
  retroReminderMaxDays: number;
  /**
   * How a retro reads the agent's sessions: a report on each one, written by a model (`reports`:
   * finer, costs more), or the agent's own summaries of them (`insights`: Claude Code's `/insights`,
   * cheaper). Never both: they tell the same sessions twice.
   */
  retroSessions: SessionsMode;
  /**
   * The sources a retro reads (the review threads, the agent's sessions, the audit of the setup):
   * always (`yes`), never (`no`), or asked at each retro (`ask`). A project's own settings
   * (`ProjectConfig`) come first.
   */
  retroSourceReviews: SourceSetting;
  retroSourceSessions: SourceSetting;
  retroSourceAudit: SourceSetting;
}

/** How a retro reads the agent's sessions (see `MachineConfig.retroSessions`). */
export type SessionsMode = 'reports' | 'insights';
export const SESSIONS_MODES: readonly SessionsMode[] = ['reports', 'insights'];

/** The sources a retro can read: the review threads, the agent's sessions, the audit of the setup. */
export type RetroSource = 'reviews' | 'sessions' | 'audit';
export const RETRO_SOURCES: readonly RetroSource[] = ['reviews', 'sessions', 'audit'];

/** Whether a retro reads a source: always, never, or asked at each retro. */
export type SourceSetting = 'yes' | 'no' | 'ask';
export const SOURCE_SETTINGS: readonly SourceSetting[] = ['yes', 'no', 'ask'];

/** The setting of each source, in the machine and project settings. */
export const SOURCE_KEY = {
  reviews: 'retroSourceReviews',
  sessions: 'retroSourceSessions',
  audit: 'retroSourceAudit',
} as const satisfies Record<RetroSource, keyof MachineConfig>;

export const DEFAULT_CONFIG: MachineConfig = {
  keepHistory: true,
  retroReminder: true,
  retroReminderDays: 7,
  retroReminderSizeKB: 1000,
  retroReminderMaxDays: 25,
  retroSessions: 'reports',
  retroSourceReviews: 'ask',
  retroSourceSessions: 'ask',
  retroSourceAudit: 'ask',
};

type BooleanKey = { [K in keyof MachineConfig]: MachineConfig[K] extends boolean ? K : never }[keyof MachineConfig];
type NumberKey = { [K in keyof MachineConfig]: MachineConfig[K] extends number ? K : never }[keyof MachineConfig];
type ChoiceKey = { [K in keyof MachineConfig]: MachineConfig[K] extends string ? K : never }[keyof MachineConfig];

export type ConfigSetting =
  | { key: BooleanKey; kind: 'boolean'; help: string }
  | { key: NumberKey; kind: 'number'; help: string }
  | { key: ChoiceKey; kind: 'choice'; choices: readonly string[]; help: string };

/** The settings as `slk config` names them, with how to read a value given on the command line. */
export const CONFIG_KEYS: Record<string, ConfigSetting> = {
  'keep-history': {
    key: 'keepHistory',
    kind: 'boolean',
    help:
      'on|off — keep deleted threads (for slk review history and retros) and save the threads of a worktree before an ' +
      'agent removes it; off, deleting a thread erases it (default: on)',
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
  'retro-sessions': {
    key: 'retroSessions',
    kind: 'choice',
    choices: SESSIONS_MODES,
    help:
      'reports|insights — how a retro reads the agent sessions: a report on each one by a model (finer, ' +
      "costs more), or the agent's own summaries (Claude Code's /insights, cheaper); never both (default: reports)",
  },
  'retro-source-reviews': {
    key: 'retroSourceReviews',
    kind: 'choice',
    choices: SOURCE_SETTINGS,
    help: 'yes|no|ask — a retro reads your review threads: always, never, or asked at each retro (default: ask)',
  },
  'retro-source-sessions': {
    key: 'retroSourceSessions',
    kind: 'choice',
    choices: SOURCE_SETTINGS,
    help: 'yes|no|ask — a retro reads your sessions with the agent: always, never, or asked (default: ask)',
  },
  'retro-source-audit': {
    key: 'retroSourceAudit',
    kind: 'choice',
    choices: SOURCE_SETTINGS,
    help: 'yes|no|ask — a retro audits your setup (/doctor prompt-audit): always, never, or asked (default: ask)',
  },
};

/** The settings a project may set for itself, in its own store: they come before the machine's. */
export const PROJECT_CONFIG_KEYS: readonly string[] = [
  'retro-source-reviews',
  'retro-source-sessions',
  'retro-source-audit',
];

export const configFile = (env: Record<string, string | undefined> = process.env): string =>
  join(silykatHome(env), 'config.json');

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
    if (setting.kind === 'choice' && typeof value === 'string' && setting.choices.includes(value))
      Object.assign(config, { [setting.key]: value });
  }
  return config;
}

/** The writes of this process, one after the other: each reads the file the previous one wrote. */
let writing: Promise<unknown> = Promise.resolve();

/**
 * Changes settings, keeping the others (and unknown keys written by a newer version). Written
 * atomically; the writes of one process run one at a time, so that none undoes another.
 */
export function writeConfig(
  change: Partial<MachineConfig>,
  env: Record<string, string | undefined> = process.env,
): Promise<MachineConfig> {
  const next = writing.then(() => writeConfigNow(change, env));
  writing = next.catch(() => undefined);
  return next;
}

async function writeConfigNow(
  change: Partial<MachineConfig>,
  env: Record<string, string | undefined>,
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
  await mkdir(silykatHome(env), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2) + '\n');
  await rename(tmp, file);
  return readConfig(env);
}

/**
 * A project's own settings, in `<home>/.silykat/config.json` (the folder whose store keeps its
 * retros): personal, like the rest of the store (git ignores it). Only the settings of
 * `PROJECT_CONFIG_KEYS`; a missing one falls back on the machine's.
 */
export type ProjectConfig = Partial<Pick<MachineConfig, (typeof SOURCE_KEY)[RetroSource]>>;

export const projectConfigFile = (home: string): string => join(home, STORE_DIR, 'config.json');

const projectKeys = () => PROJECT_CONFIG_KEYS.map((n) => CONFIG_KEYS[n]!);

/** The settings a project set for itself; an unreadable file gives none. */
export async function readProjectConfig(home: string): Promise<ProjectConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(projectConfigFile(home), 'utf8'));
  } catch {
    return {};
  }
  if (typeof raw !== 'object' || raw === null) return {};
  const values = raw as Record<string, unknown>;
  const out: ProjectConfig = {};
  for (const setting of projectKeys()) {
    const value = values[setting.key];
    if (setting.kind === 'choice' && typeof value === 'string' && setting.choices.includes(value))
      Object.assign(out, { [setting.key]: value });
  }
  return out;
}

/** Changes a project's settings, keeping the others (written atomically, one write at a time). */
export function writeProjectConfig(home: string, change: ProjectConfig): Promise<ProjectConfig> {
  const next = writing.then(async () => {
    const file = projectConfigFile(home);
    let current: Record<string, unknown> = {};
    try {
      const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) current = raw as Record<string, unknown>;
    } catch {
      // missing or invalid: start again
    }
    await mkdir(join(home, STORE_DIR), { recursive: true });
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify({ ...current, ...change }, null, 2) + '\n');
    await rename(tmp, file);
    return readProjectConfig(home);
  });
  writing = next.catch(() => undefined);
  return next;
}

/** Where a setting in force comes from. */
export type SettingOrigin = 'project' | 'machine' | 'default';

/** The setting of each source of a retro, and where it comes from. */
export interface SourceSettings {
  sources: Record<RetroSource, { setting: SourceSetting; origin: SettingOrigin }>;
  /** The project set none of them yet: its first retro asks for them. */
  projectSet: boolean;
}

export function sourceSettings(
  machineFile: Record<string, unknown> | null,
  machine: MachineConfig,
  project: ProjectConfig,
): SourceSettings {
  const sources = {} as SourceSettings['sources'];
  for (const s of RETRO_SOURCES) {
    const key = SOURCE_KEY[s];
    const own = project[key];
    sources[s] = own
      ? { setting: own, origin: 'project' }
      : { setting: machine[key], origin: machineFile && key in machineFile ? 'machine' : 'default' };
  }
  return { sources, projectSet: RETRO_SOURCES.some((s) => project[SOURCE_KEY[s]] !== undefined) };
}

/** The settings of the sources of a retro of the project whose store is in `home`. */
export async function readSourceSettings(
  home: string,
  env: Record<string, string | undefined> = process.env,
): Promise<SourceSettings> {
  let file: Record<string, unknown> | null = null;
  try {
    const raw: unknown = JSON.parse(await readFile(configFile(env), 'utf8'));
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) file = raw as Record<string, unknown>;
  } catch {
    // missing or invalid: the defaults
  }
  return sourceSettings(file, await readConfig(env), await readProjectConfig(home));
}

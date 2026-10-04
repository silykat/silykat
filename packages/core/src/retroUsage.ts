import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';

/**
 * How much the tools of the agent's setup (skills, commands, sub-agents) were used, counted by the
 * agent's adapter from the agent's own records, without a model. A retro reads it next to the audit
 * of the setup: a tool the audit flags but nobody uses is a question (keep it, or remove it?), not a
 * fix. The counts only see this machine, and only what the agent still keeps of its sessions.
 */
export type ToolKind = 'skill' | 'command' | 'agent';

export interface ToolUsage {
  kind: ToolKind;
  /** As the agent names it: `/name`, the skill or sub-agent's name. */
  name: string;
  /** `project`: in the project's files (counted on the project's sessions); `user`: the user's (counted on every project). */
  scope: 'project' | 'user';
  /** Its file (absolute): `SKILL.md`, the command or the agent's file. */
  file: string;
  /** The folder that holds it and goes with it (a skill's folder), else its file. */
  path: string;
  /** Times used: typed by the user, or called by the agent. */
  byUser: number;
  byAgent: number;
  /** Sessions it was used in. */
  sessions: number;
  /** The last time it was used (ISO), `null` when never. */
  lastUsed: string | null;
}

/** What the counts of a scope rest on: the sessions the agent still keeps. */
export interface UsageWindow {
  scope: 'project' | 'user';
  /** Sessions read: those of the project, or of every project of the machine. */
  sessions: number;
  /** The oldest of them (ISO), `null` when none. */
  since: string | null;
  /** How long the agent keeps its sessions, in days (its setting, else its default). */
  keptDays: number;
}

export interface SetupUsage {
  /** The agent whose records were read, e.g. "Claude Code". */
  source: string;
  tools: ToolUsage[];
  windows: UsageWindow[];
}

export const usesOf = (t: Pick<ToolUsage, 'byUser' | 'byAgent'>) => t.byUser + t.byAgent;

/** A path as the agents write it (relative to the project, `~/…`, or absolute, with `:lines`), resolved. */
function resolvePath(path: string, root: string, home: string): string {
  const p = path.trim().replace(/:\d+(-\d+)?$/, '');
  if (p === '~' || p.startsWith('~/')) return resolve(home, p.slice(2));
  return isAbsolute(p) ? resolve(p) : resolve(root, p);
}

const within = (path: string, dir: string) => {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** The tool a file of a proposal is about (the tool's file, or a file in its folder), if any. `home` resolves `~/`. */
export function toolOfFile(
  file: string,
  tools: readonly ToolUsage[],
  root: string,
  home: string = homedir(),
): ToolUsage | null {
  const path = resolvePath(file, root, home);
  return tools.find((t) => within(path, t.path)) ?? null;
}

/** "a skill", "a command"… */
export const TOOL_TITLE: Record<ToolKind, string> = { skill: 'skill', command: 'command', agent: 'sub-agent' };

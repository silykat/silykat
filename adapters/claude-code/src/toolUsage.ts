import { createReadStream } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { SetupUsage, ToolUsage, UsageWindow } from '@local-review/core';
import { projectTranscripts, type ProjectTranscript } from './retroInsights';
import { subagentFiles } from './sessionAnalytics';
import type { SetupTool } from './retroSetup';

/**
 * How much the skills, commands and sub-agents of the setup were used, from Claude Code's own
 * conversations, without a model: a skill called by the agent (`Skill`) or typed by the user
 * (`/name`), a command typed, a sub-agent launched (`Agent`). The project's tools are counted on the
 * project's sessions, the user's on every session of the machine. Claude Code deletes the sessions
 * inactive for longer than `cleanupPeriodDays` (30 days by default): older uses are not seen.
 */
export const USAGE_SOURCE = 'Claude Code';
export const DEFAULT_KEPT_DAYS = 30;

type Env = Record<string, string | undefined>;

/** What one session used: names typed by the user, called by the agent, and sub-agents launched. */
export interface SessionUse {
  typed: Map<string, number>;
  called: Map<string, number>;
  agents: Map<string, number>;
  /** When it was last active (ISO). */
  last: string | null;
}

const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const COMMAND = /<command-name>\/?([^<]+)<\/command-name>/;

/** The text of a user message, typed or injected. */
function userText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(isRecord)
    .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .join('\n');
}

/** Reads one conversation file into `use`. Only the lines that may hold a use are parsed. */
async function readUses(file: string, use: SessionUse): Promise<void> {
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const ts = /"timestamp":"([^"]+)"/.exec(line)?.[1];
      if (ts && (use.last === null || ts > use.last)) use.last = ts;
      if (!line.includes('command-name') && !line.includes('"Skill"') && !line.includes('subagent_type')) continue;
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const m = isRecord(e.message) ? e.message : {};
      if (e.type === 'user') {
        const cmd = COMMAND.exec(userText(m.content));
        if (cmd) bump(use.typed, cmd[1]!.trim());
      } else if (e.type === 'assistant' && Array.isArray(m.content))
        for (const b of m.content.filter(isRecord)) {
          if (b.type !== 'tool_use' || !isRecord(b.input)) continue;
          if (b.name === 'Skill' && typeof b.input.skill === 'string') bump(use.called, b.input.skill.trim());
          if ((b.name === 'Agent' || b.name === 'Task') && typeof b.input.subagent_type === 'string')
            bump(use.agents, b.input.subagent_type.trim());
        }
    }
  } finally {
    lines.close();
  }
}

/** What a session used, its sub-agents included. */
export async function sessionUses(file: string): Promise<SessionUse> {
  const use: SessionUse = { typed: new Map(), called: new Map(), agents: new Map(), last: null };
  await readUses(file, use);
  for (const s of await subagentFiles(file)) await readUses(s.file, use);
  return use;
}

/** Every conversation of the machine (one file per session), whatever its project. */
async function allTranscripts(claudeDir: string): Promise<string[]> {
  const projects = join(claudeDir, 'projects');
  const out: string[] = [];
  for (const dir of await readdir(projects).catch(() => [] as string[]))
    for (const name of await readdir(join(projects, dir)).catch(() => [] as string[]))
      if (name.endsWith('.jsonl')) out.push(join(projects, dir, name));
  return out;
}

/** How long Claude Code keeps its sessions: `cleanupPeriodDays` of the user's settings, else 30 days. */
export async function keptDays(claudeDir: string): Promise<number> {
  try {
    const raw = JSON.parse(await readFile(join(claudeDir, 'settings.json'), 'utf8')) as { cleanupPeriodDays?: unknown };
    const n = raw.cleanupPeriodDays;
    return typeof n === 'number' && n > 0 ? n : DEFAULT_KEPT_DAYS;
  } catch {
    return DEFAULT_KEPT_DAYS;
  }
}

/** The names a use of a tool can take: a plugin's skills are `plugin:name`, ours are bare. */
const named = (m: ReadonlyMap<string, number>, name: string) => m.get(name) ?? 0;

/** The counts of the tools on some sessions. */
export function countUses(
  tools: readonly SetupTool[],
  sessions: readonly SessionUse[],
): Omit<ToolUsage, 'kind' | 'name' | 'scope' | 'file' | 'path'>[] {
  return tools.map((t) => {
    let byUser = 0;
    let byAgent = 0;
    let used = 0;
    let lastUsed: string | null = null;
    for (const s of sessions) {
      const u = t.kind === 'agent' ? 0 : named(s.typed, t.name);
      const a = t.kind === 'agent' ? named(s.agents, t.name) : t.kind === 'skill' ? named(s.called, t.name) : 0;
      // A command can be called by the agent through the Skill tool too.
      const c = t.kind === 'command' ? named(s.called, t.name) : 0;
      byUser += u;
      byAgent += a + c;
      if (u + a + c > 0) {
        used++;
        if (s.last && (lastUsed === null || s.last > lastUsed)) lastUsed = s.last;
      }
    }
    return { byUser, byAgent, sessions: used, lastUsed };
  });
}

/** Oldest start of some sessions. */
const oldest = (xs: readonly ProjectTranscript[]) => xs.map((x) => x.start).sort()[0] ?? null;

/**
 * The usage of the setup's tools: the project's on the project's sessions, the user's on every
 * session the machine keeps (the retro's own session left out: it uses the retro, not the setup).
 */
export async function setupUsage(
  tools: readonly SetupTool[],
  claudeDir: string,
  root: string,
  env: Env,
  exclude: ReadonlySet<string> = new Set(),
): Promise<SetupUsage> {
  const until = new Date().toISOString();
  const project = (await projectTranscripts(claudeDir, root, { since: null, until }, env)).filter(
    (t) => !exclude.has(t.id),
  );
  const projectUses = await Promise.all(project.map((t) => sessionUses(t.file)));
  const userTools = tools.filter((t) => t.scope === 'user');
  let all: string[] = [];
  let allUses: SessionUse[] = [];
  let allSince: string | null = null;
  if (userTools.length > 0) {
    all = (await allTranscripts(claudeDir)).filter(
      (f) => !exclude.has(f.slice(f.lastIndexOf('/') + 1, -'.jsonl'.length)),
    );
    allUses = await Promise.all(all.map((f) => sessionUses(f)));
    allSince =
      allUses
        .map((u) => u.last)
        .filter((x): x is string => x !== null)
        .sort()[0] ?? null;
  }
  const kept = await keptDays(claudeDir);
  const projectTools = tools.filter((t) => t.scope === 'project');
  const counts = new Map<SetupTool, ReturnType<typeof countUses>[number]>();
  countUses(projectTools, projectUses).forEach((c, i) => counts.set(projectTools[i]!, c));
  countUses(userTools, allUses).forEach((c, i) => counts.set(userTools[i]!, c));
  const windows: UsageWindow[] = [
    { scope: 'project', sessions: project.length, since: oldest(project), keptDays: kept },
    ...(userTools.length ? [{ scope: 'user' as const, sessions: all.length, since: allSince, keptDays: kept }] : []),
  ];
  return {
    source: USAGE_SOURCE,
    tools: tools.map((t) => ({
      kind: t.kind,
      name: t.name,
      scope: t.scope,
      file: t.file,
      path: t.path,
      ...counts.get(t)!,
    })),
    windows,
  };
}

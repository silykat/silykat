import { appendFile, mkdir, readFile, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { projectStores } from './project';
import { localReviewHome } from './sessions';
import { worktreesOf } from './worktrees';

/**
 * The agent sessions seen on this machine, with the folder each one was started in: written by the
 * agent's adapter (for Claude Code, its hook at the start of each session, and once the sessions
 * Claude Code still keeps), read by the cadence of retros, which counts them next to the review
 * threads. `<home>/agent-sessions.jsonl`, append-only; a session seen twice counts once.
 */
export interface AgentSessionEntry {
  /** The agent's own session id. */
  id: string;
  /** Display name of the agent, e.g. "Claude". */
  agent: string;
  cwd: string;
  startedAt: string;
}

const LOG_VERSION = 1;

type LogLine =
  | ({ v: number; type: 'session' } & AgentSessionEntry)
  /** The sessions an agent kept in `source` (e.g. a folder of Claude Code) were all recorded. */
  | { v: number; type: 'imported'; source: string; at: string };

export const agentSessionsFile = (env: Record<string, string | undefined> = process.env): string =>
  join(localReviewHome(env), 'agent-sessions.jsonl');

export interface AgentSessionLog {
  /** Each session once, with its earliest start. */
  sessions: AgentSessionEntry[];
  /** The sources whose sessions were all recorded once. */
  imported: Set<string>;
}

/** The sessions recorded; an unreadable line is skipped (a hook must never fail on it). */
export async function readAgentSessions(
  env: Record<string, string | undefined> = process.env,
): Promise<AgentSessionLog> {
  let text = '';
  try {
    text = await readFile(agentSessionsFile(env), 'utf8');
  } catch {
    return { sessions: [], imported: new Set() };
  }
  const byId = new Map<string, AgentSessionEntry>();
  const imported = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e: Partial<LogLine>;
    try {
      e = JSON.parse(line) as Partial<LogLine>;
    } catch {
      continue;
    }
    if (typeof e !== 'object' || e === null || typeof e.v !== 'number' || e.v > LOG_VERSION) continue;
    if (e.type === 'imported' && typeof e.source === 'string') imported.add(e.source);
    if (
      e.type === 'session' &&
      typeof e.id === 'string' &&
      typeof e.cwd === 'string' &&
      typeof e.startedAt === 'string' &&
      !Number.isNaN(Date.parse(e.startedAt))
    ) {
      const known = byId.get(e.id);
      if (!known || e.startedAt < known.startedAt)
        byId.set(e.id, {
          id: e.id,
          agent: typeof e.agent === 'string' ? e.agent : '',
          cwd: e.cwd,
          startedAt: e.startedAt,
        });
    }
  }
  return { sessions: [...byId.values()], imported };
}

/**
 * Records sessions, and with `imported` that every session the agent keeps in that source is now
 * recorded (so that it is not done again).
 */
export async function recordAgentSessions(
  entries: readonly AgentSessionEntry[],
  opts: { env?: Record<string, string | undefined>; imported?: string } = {},
): Promise<void> {
  const env = opts.env ?? process.env;
  const lines: LogLine[] = entries.map((x) => ({ v: LOG_VERSION, type: 'session', ...x }));
  if (opts.imported)
    lines.push({ v: LOG_VERSION, type: 'imported', source: opts.imported, at: new Date().toISOString() });
  if (lines.length === 0) return;
  await mkdir(localReviewHome(env), { recursive: true });
  await appendFile(agentSessionsFile(env), lines.map((l) => JSON.stringify(l) + '\n').join(''));
}

/**
 * The folders of a project, where its agent sessions run: the folder, its git worktrees, and the
 * stores below it or in other worktrees; each by its real path too (/tmp and /private/tmp on macOS).
 */
export async function projectFolders(
  root: string,
  env: Record<string, string | undefined> = process.env,
): Promise<string[]> {
  const top = resolve(root);
  const folders = new Set<string>([top]);
  for (const wt of await worktreesOf(top)) folders.add(wt);
  for (const s of await projectStores(top, env))
    if (s.origin === 'worktree' || s.origin === 'below') folders.add(s.root);
  for (const f of [...folders]) folders.add(await realpath(f).catch(() => f));
  return [...folders];
}

/** Whether `path` is one of `folders` or inside one. */
export const inFolders = (path: string, folders: readonly string[]): boolean =>
  folders.some((f) => path === f || path.startsWith(f.endsWith(sep) ? f : f + sep));

/** The agent sessions recorded for a project, started after `since` (`null`: any time). */
export async function projectAgentSessions(
  root: string,
  since: string | null,
  env: Record<string, string | undefined> = process.env,
): Promise<AgentSessionEntry[]> {
  const { sessions } = await readAgentSessions(env);
  if (sessions.length === 0) return [];
  const folders = await projectFolders(root, env);
  return sessions
    .filter((x) => (since === null || x.startedAt > since) && inFolders(x.cwd, folders))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

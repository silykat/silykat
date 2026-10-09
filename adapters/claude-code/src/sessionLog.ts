import { readAgentSessions, recordAgentSessions, type AgentSessionEntry } from '@local-review/core';
import { allTranscripts, PROGRAM_ENTRYPOINT } from './retroInsights';

/** Whether Claude Code was launched by a program (`claude -p`, `--print`), from its command line. */
export const isPrintMode = (commandLine: string): boolean =>
  commandLine
    .trim()
    .split(/\s+/)
    .some((a) => a === '-p' || a === '--print');

/**
 * Records a session of Claude Code in Local Review's log of agent sessions, for the cadence of
 * retros; the first time for this Claude Code folder, every session it still keeps too (those run
 * by a program left out).
 */
export async function recordClaudeSession(
  session: { id: string; cwd: string; startedAt: string },
  claudeDir: string,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const log = await readAgentSessions(env);
  const first = !log.imported.has(claudeDir);
  const entries: AgentSessionEntry[] = [];
  if (first)
    for (const t of await allTranscripts(claudeDir))
      if (t.entrypoint !== PROGRAM_ENTRYPOINT && t.id !== session.id)
        entries.push({ id: t.id, agent: 'Claude', cwd: t.cwd, startedAt: t.start });
  if (!log.sessions.some((x) => x.id === session.id)) entries.push({ ...session, agent: 'Claude' });
  await recordAgentSessions(entries, { env, ...(first ? { imported: claudeDir } : {}) });
}

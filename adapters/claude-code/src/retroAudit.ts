import { execFile } from 'node:child_process';

/**
 * Claude Code's own audit of its setup (`/doctor prompt-audit`: stale, contradictory or duplicated
 * rules in CLAUDE.md files, skills, agents, commands), run by a retro alongside its classification.
 * It runs in a separate, non-interactive Claude Code, read-only: no shell, no edit.
 */
export const AUDIT_COMMAND = '/doctor prompt-audit';
/** The first version of Claude Code with `/doctor prompt-audit`. */
export const AUDIT_MIN_VERSION: readonly [number, number, number] = [2, 1, 283];
/** The model of the audit: the most careful one, as for the analysis. */
export const AUDIT_MODEL = 'opus';
export const AUDIT_TIMEOUT_MS = 15 * 60_000;

export interface RunResult {
  stdout: string;
  stderr: string;
  /** `null` when the process could not start, or was stopped. */
  code: number | null;
  timedOut: boolean;
}

export type Runner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: Record<string, string | undefined>; timeoutMs: number },
) => Promise<RunResult>;

export const runProcess: Runner = (command, args, { cwd, env, timeoutMs }) =>
  new Promise((resolve) => {
    execFile(command, args, { cwd, env, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
      resolve({
        stdout,
        stderr,
        code: e ? (typeof e.code === 'number' ? e.code : null) : 0,
        timedOut: Boolean(e?.killed),
      });
    });
  });

/** The arguments of the audit: the prompt first, since `--disallowedTools` and `--add-dir` take several values. */
export function auditArgs(claudeDir: string): string[] {
  return [
    '-p',
    AUDIT_COMMAND,
    '--model',
    AUDIT_MODEL,
    '--permission-mode',
    'default',
    '--disallowedTools',
    'Bash',
    'Edit',
    'Write',
    'NotebookEdit',
    '--add-dir',
    claudeDir,
    '--output-format',
    'json',
  ];
}

export type AuditOutcome =
  | { kind: 'done'; report: string; costUsd: number | null; durationMs: number | null }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; reason: string };

const parseVersion = (text: string): [number, number, number] | null => {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

const atLeast = (v: readonly number[], min: readonly number[]) => {
  for (let i = 0; i < min.length; i++) if (v[i] !== min[i]) return v[i]! > min[i]!;
  return true;
};

/** Runs the audit in `root`, letting it read the user's setup in `claudeDir` too. */
export async function runAudit(
  root: string,
  claudeDir: string,
  env: Record<string, string | undefined>,
  run: Runner = runProcess,
  timeoutMs = AUDIT_TIMEOUT_MS,
): Promise<AuditOutcome> {
  const claude = env.SLK_CLAUDE_BIN?.trim() || 'claude';
  const v = await run(claude, ['--version'], { cwd: root, env, timeoutMs: 30_000 });
  const version = v.code === 0 ? parseVersion(v.stdout) : null;
  if (!version) return { kind: 'skipped', reason: 'Claude Code was not found' };
  if (!atLeast(version, AUDIT_MIN_VERSION))
    return {
      kind: 'skipped',
      reason: `${AUDIT_COMMAND} needs Claude Code ${AUDIT_MIN_VERSION.join('.')} or later (here ${version.join('.')})`,
    };
  const r = await run(claude, auditArgs(claudeDir), { cwd: root, env, timeoutMs });
  if (r.timedOut) return { kind: 'failed', reason: `it took more than ${Math.round(timeoutMs / 60_000)} min` };
  let out: { result?: unknown; is_error?: unknown; total_cost_usd?: unknown; duration_ms?: unknown };
  try {
    out = JSON.parse(r.stdout) as typeof out;
  } catch {
    const why = (r.stderr || r.stdout).trim().split('\n').at(-1) ?? '';
    return { kind: 'failed', reason: `Claude Code ended with code ${r.code ?? '?'}${why ? `: ${why}` : ''}` };
  }
  const report = typeof out.result === 'string' ? out.result.trim() : '';
  if (out.is_error === true || !report)
    return { kind: 'failed', reason: report ? report.split('\n')[0]! : 'the audit gave no report' };
  return {
    kind: 'done',
    report,
    costUsd: typeof out.total_cost_usd === 'number' ? out.total_cost_usd : null,
    durationMs: typeof out.duration_ms === 'number' ? out.duration_ms : null,
  };
}

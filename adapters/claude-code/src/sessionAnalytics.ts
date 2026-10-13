import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * The `SessionAnalytics` of a Claude Code session: what its records say, computed without a model.
 * Claude Code keeps one conversation per session (`projects/<folder>/<session>.jsonl`) and one per
 * sub-agent (`projects/<folder>/<session>/subagents/**\/agent-<id>.jsonl`, with `agent-<id>.meta.json`
 * telling who launched it; Workflow agents under `subagents/workflows/`). They are read together.
 *
 * Every signal occurrence points at a moment of the conversation: the agent that produced it, the
 * line's `uuid`, its time and its line number. The format is Claude Code's own, without a contract:
 * an unknown field is ignored, an unreadable line skipped.
 */
export const ANALYTICS_SCHEMA = 'session-analytics/1';

/** The signals, by family: every one is present in an analytics, even when empty. */
export const FAMILIES = {
  collaboration: ['friction', 'corrections', 'user_edits', 'agent_questions'],
  tools: ['permission_blocks', 'tool_errors', 'repeated_failures', 'hooks'],
  setup: ['skills', 'commands', 'subagents'],
  workflow: ['context_pressure', 'handoff', 'repeated_requests', 'autonomy'],
  cost: ['api_errors'],
  delivery: ['pull_requests', 'git', 'silykat_messages'],
} as const;

type Json = Record<string, unknown>;
export type Occurrence = Json;
export type Signals = Record<string, Record<string, Occurrence[]>>;

export interface AgentInfo {
  id: string;
  type: string | null;
  description: string | null;
  launchedBy: string | null;
  workflow: boolean;
  lines: number;
  file: string;
}

export interface SessionAnalytics {
  schema: string;
  session_id: string;
  cwd: string | null;
  branches: string[];
  start: string | null;
  end: string | null;
  claude_code_versions: string[];
  entrypoints: string[];
  title: string | null;
  custom_title: string | null;
  agents: AgentInfo[];
  counts: {
    typed_prompts: number;
    /** Lines of the session and its sub-agents: a session that grew is analysed again. */
    lines: number;
    tool_calls: Record<string, number>;
    commands: Record<string, number>;
    away_summaries: number;
    turns: number;
    turn_duration_ms_total: number;
    permission_modes: Record<string, number>;
  };
  setup: {
    instructions_loaded: Record<string, { type: unknown; bytes: number; sha1: string }>;
    skills_available: string[];
    skills_available_never_called: string[];
    skills_active_messages: Record<string, number>;
  };
  cost: {
    tokens_by_model: Record<string, Record<string, number>>;
    cost_state: Json | null;
    models: Record<string, number>;
  };
  signals: Signals;
}

/** Texts Claude Code injects as user messages: not typed by the user. */
const INJECTED = new RegExp(
  '^\\s*(<(channel|local-command-caveat|local-command-stdout|local-command-stderr|command-name|command-message|' +
    'command-args|task-notification|system-reminder|ide_opened_file|ide_selection|bash-input|bash-stdout|' +
    'bash-stderr|user-prompt-submit-hook|cross-session-message)\\b|\\[SYSTEM NOTIFICATION|\\[Workflow harness|' +
    '\\[Request interrupted|\\[Your previous response)',
);
const COMMAND = /<command-name>\/?([^<]+)<\/command-name>/;
const GIT = /\b(git\s+(commit|push|merge|rebase|revert|reset|cherry-pick)|gh\s+pr\s+(create|merge|edit))\b/;
const SECRET = new RegExp(
  '(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|' +
    'AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}|' +
    '-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----|' +
    '\\b(?:[Pp][Aa][Ss][Ss][Ww](?:[Oo][Rr])?[Dd]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Tt][Oo][Kk][Ee][Nn]|[Aa][Pp][Ii][_-]?[Kk][Ee][Yy])\\s*[=:]\\s*\\S+)',
  'g',
);

/** Built-in commands of Claude Code: anything else typed as `/name` is a skill or a plugin's command. */
const BUILTIN = new Set([
  'clear', 'compact', 'model', 'login', 'logout', 'doctor', 'plugin', 'mcp', 'reload-plugins', 'privacy-settings',
  'effort', 'feedback', 'context', 'remote-control', 'usage', 'config', 'help', 'resume', 'status', 'insights',
  'init', 'review', 'memory', 'permissions', 'hooks', 'agents', 'add-dir', 'rewind', 'export', 'cost', 'exit', 'fast',
]); // prettier-ignore

/** Secrets masked in a text: keys, tokens, passwords. */
export const mask = (text: string): string => text.replace(SECRET, '[secret]');

/** A text masked and cut to `n` characters. */
export function cut(text: unknown, n: number): string {
  const t = mask(typeof text === 'string' ? text : '');
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

const isRecord = (x: unknown): x is Json => typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (x: unknown): string | null => (typeof x === 'string' ? x : null);
/** A string field, or `''`. */
const strOf = (x: unknown): string => (typeof x === 'string' ? x : '');
/** A field as recorded, `null` when it is missing. */
const orNull = (x: unknown): unknown => x ?? null;
/** A value as text: itself when it is one, else its JSON. */
const asText = (x: unknown): string => (typeof x === 'string' ? x : JSON.stringify(x ?? ''));

/** The text blocks of a message's content. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .filter((b): b is Json => isRecord(b) && b.type === 'text')
      .map((b) => strOf(b.text))
      .join('\n');
  return '';
}

/** What a tool call was about, in a few words. */
export function toolSummary(name: string, input: unknown): string {
  const inp = isRecord(input) ? input : {};
  if (name === 'Bash') return cut(inp.command, 300);
  for (const key of ['file_path', 'notebook_path', 'path', 'pattern', 'url', 'query', 'skill', 'subagent_type'])
    if (key in inp) return cut(String(inp[key]), 200);
  if (name === 'Agent') return cut(inp.description, 200);
  return '';
}

/** Leading steps of a command that only set the scene: `cd`, `source`, `export`, `nvm use`, `VAR=x`. */
const SETUP_STEP =
  /^(cd\s+\S+|source\s+\S+(\s*[>&\d/a-z]*\/dev\/null)?|\.\s+\S+|export\s+\S+|nvm\s+use\b[^&;|]*|[A-Z_][A-Z0-9_]*=\S*)\s*(&&|;)\s*/;

/** A Bash command reduced to its first words, to group repeated commands (setup steps skipped). */
export function normCommand(cmd: unknown): string {
  let c = (typeof cmd === 'string' ? cmd : '').replace(/\s+/g, ' ').trim();
  for (let m = SETUP_STEP.exec(c); m; m = SETUP_STEP.exec(c)) c = c.slice(m[0].length);
  return c.split(' ').slice(0, 3).join(' ');
}

/** One file of the session: the main conversation or a sub-agent's. */
interface AgentFile {
  id: string;
  file: string;
  meta: Json;
  lines: { n: number; e: Json }[];
}

/** The lines of a JSONL file, parsed; unreadable lines skipped. */
export async function readJsonl(file: string): Promise<{ n: number; e: Json }[]> {
  const text = await readFile(file, 'utf8');
  const out: { n: number; e: Json }[] = [];
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const e: unknown = JSON.parse(line);
      if (isRecord(e)) out.push({ n: i + 1, e });
    } catch {
      // a line being written, or not JSON: skipped
    }
  });
  return out;
}

/** Every file under `dir`, recursively. */
async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const d of entries) {
    const p = join(dir, d.name);
    if (d.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

/** The sub-agents' conversations of a session, with their meta: `[id, file, meta]`. */
export async function subagentFiles(sessionFile: string): Promise<{ id: string; file: string; meta: Json }[]> {
  const dir = join(dirname(sessionFile), basename(sessionFile, '.jsonl'), 'subagents');
  const files = (await walk(dir)).filter((f) => /\/agent-[^/]+\.jsonl$/.test(f)).sort();
  const out: { id: string; file: string; meta: Json }[] = [];
  for (const file of files) {
    let meta: Json = {};
    try {
      const raw: unknown = JSON.parse(await readFile(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
      if (isRecord(raw)) meta = raw;
    } catch {
      // no meta: an agent of unknown type
    }
    if (file.includes('/workflows/')) meta = { ...meta, workflow: true };
    out.push({ id: basename(file, '.jsonl').slice('agent-'.length), file, meta });
  }
  return out;
}

const bump = (m: Map<string, number>, k: string, by = 1) => m.set(k, (m.get(k) ?? 0) + by);
const sorted = (m: Map<string, number>) => Object.fromEntries([...m].sort((a, b) => b[1] - a[1]));
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 12);

/** The `SessionAnalytics` of the session whose conversation is `sessionFile`. */
export async function analyseSession(sessionFile: string): Promise<SessionAnalytics> {
  const sid = basename(sessionFile, '.jsonl');
  const agents: AgentFile[] = [{ id: 'main', file: sessionFile, meta: {}, lines: await readJsonl(sessionFile) }];
  for (const s of await subagentFiles(sessionFile)) agents.push({ ...s, lines: await readJsonl(s.file) });

  const sig: Signals = {};
  const add = (family: string, name: string, occ: Occurrence) => ((sig[family] ??= {})[name] ??= []).push(occ);
  const cwd = new Map<string, number>();
  const branches = new Map<string, number>();
  const versions = new Set<string>();
  const entrypoints = new Set<string>();
  const models = new Map<string, number>();
  const titles: string[] = [];
  const customTitles: string[] = [];
  const times: string[] = [];
  const permissionModes = new Map<string, number>();
  const usage = new Map<string, Map<string, number>>();
  const prompts: Occurrence[] = [];
  const skillsAvailable = new Set<string>();
  const skillsActive = new Map<string, number>();
  const instructions: SessionAnalytics['setup']['instructions_loaded'] = {};
  const toolCalls = new Map<string, number>();
  const commands = new Map<string, number>();
  const errorsByCommand = new Map<string, string[]>();
  let away = 0;
  const turnMs: number[] = [];
  let costState: Json | null = null;

  for (const agent of agents) {
    const at = (n: number, e: Json, extra: Json = {}): Occurrence => ({
      agent: agent.id,
      uuid: orNull(e.uuid),
      time: orNull(e.timestamp),
      line: n,
      ...extra,
    });
    const toolNames = new Map<string, { name: string; input: Json }>();
    const seenMessages = new Set<string>();
    let actionsSincePrompt: string[] = [];
    let bashSincePrompt: string[] = [];
    let lastPrompt: Json | null = null;
    let firstUser = true;
    for (const { n, e } of agent.lines) {
      const t = e.type;
      if (typeof e.timestamp === 'string') times.push(e.timestamp);
      if (agent.id === 'main') {
        if (typeof e.cwd === 'string') bump(cwd, e.cwd);
        if (typeof e.gitBranch === 'string' && e.gitBranch) bump(branches, e.gitBranch);
        if (typeof e.version === 'string') versions.add(e.version);
        if (typeof e.entrypoint === 'string') entrypoints.add(e.entrypoint);
      }
      if (t === 'ai-title' && typeof e.aiTitle === 'string') titles.push(e.aiTitle);
      else if (t === 'custom-title' && typeof e.customTitle === 'string') customTitles.push(e.customTitle);
      else if (t === 'permission-mode') bump(permissionModes, String(e.permissionMode));
      else if (t === 'cost-state' && agent.id === 'main') {
        costState = {};
        for (const k of [
          'totalCostUSD',
          'totalAPIDuration',
          'totalToolDuration',
          'totalDuration',
          'totalLinesAdded',
          'totalLinesRemoved',
        ])
          costState[k] = orNull(e[k]);
      } else if (t === 'pr-link') {
        // Claude Code links the same pull request again and again: once each, with how many times.
        const known = (sig.delivery?.pull_requests ?? []).find(
          (o) => o.pr === orNull(e.prNumber) && o.repo === orNull(e.prRepository),
        );
        if (known) known.links = Number(known.links) + 1;
        else
          add('delivery', 'pull_requests', {
            agent: agent.id,
            time: orNull(e.timestamp),
            line: n,
            pr: orNull(e.prNumber),
            repo: orNull(e.prRepository),
            links: 1,
          });
      } else if (t === 'system') {
        const st = e.subtype;
        if (st === 'turn_duration' && typeof e.durationMs === 'number') turnMs.push(e.durationMs);
        else if (st === 'compact_boundary') {
          const cm = isRecord(e.compactMetadata) ? e.compactMetadata : {};
          add(
            'workflow',
            'context_pressure',
            at(n, e, {
              kind: 'compaction',
              trigger: orNull(cm.trigger),
              pre_tokens: orNull(cm.preTokens),
              post_tokens: orNull(cm.postTokens),
              last_prompt_before: lastPrompt,
            }),
          );
        } else if (st === 'away_summary') away++;
        else if (st === 'stop_hook_summary')
          add(
            'tools',
            'hooks',
            at(n, e, {
              kind: 'stop',
              hook_count: orNull(e.hookCount),
              errors: Array.isArray(e.hookErrors) ? e.hookErrors.length : 0,
              prevented_continuation: orNull(e.preventedContinuation),
            }),
          );
        else if (st === 'local_command') {
          const m = COMMAND.exec(strOf(e.content));
          if (m) bump(commands, m[1]!.trim());
        }
      } else if (t === 'attachment') {
        const a = isRecord(e.attachment) ? e.attachment : {};
        const kind = a.type;
        if (kind === 'skill_listing' && Array.isArray(a.names)) {
          for (const name of a.names) if (typeof name === 'string') skillsAvailable.add(name);
        } else if (kind === 'instructions' && Array.isArray(a.files)) {
          for (const fi of a.files.filter(isRecord)) {
            const content = asText(fi.content);
            instructions[String(fi.path)] = {
              type: orNull(fi.type),
              bytes: Buffer.byteLength(content),
              sha1: sha1(content),
            };
          }
        } else if (kind === 'nested_memory') {
          const content = asText(a.content);
          instructions[String(a.path)] = { type: 'nested', bytes: Buffer.byteLength(content), sha1: sha1(content) };
        } else if (kind === 'hook_success' || kind === 'hook_non_blocking_error')
          add(
            'tools',
            'hooks',
            at(n, e, {
              kind: kind === 'hook_non_blocking_error' ? 'error' : 'output',
              hook: orNull(a.hookName),
              event: orNull(a.hookEvent),
              exit_code: orNull(a.exitCode),
              output: cut(strOf(a.stdout) + strOf(a.stderr), 300),
            }),
          );
        else if (kind === 'hook_additional_context')
          add(
            'tools',
            'hooks',
            at(n, e, {
              kind: 'context',
              hook: orNull(a.hookName),
              event: orNull(a.hookEvent),
              output: cut(asText(a.content), 300),
            }),
          );
        else if (kind === 'edited_text_file') {
          const file = strOf(a.filename);
          // Claude Code also reports the files the agent changed through a command (sed, a script).
          const name = basename(file);
          const byAgent = name !== '' && bashSincePrompt.some((c) => c.includes(name));
          add(
            'collaboration',
            'user_edits',
            at(n, e, { kind: byAgent ? 'file_changed_by_agent_command' : 'file_edited_outside_agent', file }),
          );
        } else if (kind === 'queued_command')
          add(
            'workflow',
            'autonomy',
            at(n, e, { kind: 'message_while_working', text: cut(typeof a.prompt === 'string' ? a.prompt : '', 300) }),
          );
        else if (kind === 'plan_mode' || kind === 'plan_mode_exit') add('workflow', 'autonomy', at(n, e, { kind }));
      } else if (t === 'assistant') {
        const m = isRecord(e.message) ? e.message : {};
        const model = str(m.model) ?? '?';
        if (typeof m.model === 'string') bump(models, m.model);
        const mid = str(m.id);
        if (mid && !seenMessages.has(mid)) {
          seenMessages.add(mid);
          const u = isRecord(m.usage) ? m.usage : {};
          for (const [k, v] of Object.entries(u))
            if (typeof v === 'number' && Number.isInteger(v)) {
              const byModel = usage.get(model) ?? new Map<string, number>();
              usage.set(model, byModel);
              bump(byModel, k, v);
            }
        }
        if (typeof e.attributionSkill === 'string') bump(skillsActive, e.attributionSkill);
        if (e.isApiErrorMessage) add('cost', 'api_errors', at(n, e, { status: orNull(e.apiErrorStatus) }));
        for (const b of Array.isArray(m.content) ? m.content.filter(isRecord) : []) {
          if (b.type !== 'tool_use') continue;
          const name = str(b.name) ?? '?';
          const input = isRecord(b.input) ? b.input : {};
          if (typeof b.id === 'string') toolNames.set(b.id, { name, input });
          bump(toolCalls, name);
          actionsSincePrompt.push(name);
          if (name === 'Bash') bashSincePrompt.push(strOf(input.command));
          if (name === 'Skill')
            add('setup', 'skills', at(n, e, { kind: 'called_by_agent', skill: orNull(input.skill) }));
          else if (name === 'Agent' || name === 'Task')
            add(
              'setup',
              'subagents',
              at(n, e, {
                kind: 'launched',
                subagent_type: input.subagent_type ?? 'general-purpose',
                description: cut(input.description, 200),
                tool_use_id: orNull(b.id),
              }),
            );
          else if (name === 'AskUserQuestion') {
            const qs = (Array.isArray(input.questions) ? input.questions.filter(isRecord) : []).map((q) =>
              cut(q.question, 300),
            );
            add('collaboration', 'agent_questions', at(n, e, { questions: qs, tool_use_id: orNull(b.id) }));
          }
        }
      } else if (t === 'user') {
        const m = isRecord(e.message) ? e.message : {};
        const content = m.content;
        const tur = isRecord(e.toolUseResult) ? e.toolUseResult : {};
        const results = Array.isArray(content) ? content.filter((b) => isRecord(b) && b.type === 'tool_result') : [];
        for (const b of results as Json[]) {
          const { name, input } = toolNames.get(String(b.tool_use_id)) ?? { name: '?', input: {} };
          const command = name === 'Bash' ? strOf(input.command) : '';
          if (b.is_error) {
            const err = typeof b.content === 'string' ? b.content : textOf(b.content);
            add(
              'tools',
              'tool_errors',
              at(n, e, { tool: name, target: toolSummary(name, input), error: cut(err, 300) }),
            );
            if (name === 'Bash') {
              const key = normCommand(command);
              errorsByCommand.set(key, [...(errorsByCommand.get(key) ?? []), String(e.uuid)]);
            }
          }
          if (name === 'Bash' && tur.interrupted)
            add(
              'collaboration',
              'friction',
              at(n, e, { kind: 'command_interrupted', target: toolSummary(name, input) }),
            );
          const git = name === 'Bash' ? GIT.exec(command) : null;
          if (name === 'Bash' && (tur.gitOperation || git) && !b.is_error)
            add(
              'delivery',
              'git',
              at(n, e, { operation: tur.gitOperation ?? git?.[1] ?? null, target: toolSummary(name, input) }),
            );
          if ((name === 'Edit' || name === 'Write') && tur.userModified)
            add(
              'collaboration',
              'user_edits',
              at(n, e, { kind: 'proposal_modified_by_user', file: orNull(tur.filePath) }),
            );
          if (name === 'Skill' && tur.success === false)
            add('setup', 'skills', at(n, e, { kind: 'failed', skill: orNull(tur.commandName) }));
          if ((name === 'Agent' || name === 'Task') && Object.keys(tur).length)
            add(
              'setup',
              'subagents',
              at(n, e, {
                kind: 'result',
                status: orNull(tur.status),
                model: orNull(tur.resolvedModel),
                tokens: orNull(tur.totalTokens),
                duration_ms: orNull(tur.totalDurationMs),
                tool_use_id: orNull(b.tool_use_id),
              }),
            );
          if (name === 'AskUserQuestion' && Object.keys(tur).length)
            add(
              'collaboration',
              'agent_questions',
              at(n, e, {
                kind: 'answers',
                answers: cut(JSON.stringify(orNull(tur.answers)), 400),
                tool_use_id: orNull(b.tool_use_id),
              }),
            );
        }
        const denial = str(e.toolDenialKind);
        if (denial) {
          const first = results[0] as Json | undefined;
          const { name, input } = (first && toolNames.get(String(first.tool_use_id))) ?? { name: '?', input: {} };
          const occ = at(n, e, {
            denial,
            tool: name,
            target: toolSummary(name, input),
            reason: cut(e.userFeedback, 300),
          });
          if (denial === 'user-rejected') add('collaboration', 'friction', { ...occ, kind: 'refused_by_user' });
          else add('tools', 'permission_blocks', { ...occ, kind: denial });
        }
        const text = results.length ? '' : textOf(content);
        if (text.startsWith('[Request interrupted'))
          add(
            'collaboration',
            'friction',
            at(n, e, {
              kind: 'interruption',
              interrupted_message: orNull(e.interruptedMessageId),
              agent_was_doing: actionsSincePrompt.slice(-5),
            }),
          );
        const cmd = text ? COMMAND.exec(text) : null;
        if (cmd) {
          const name = cmd[1]!.trim();
          bump(commands, name);
          if (name === 'clear' && firstUser)
            add('workflow', 'context_pressure', at(n, e, { kind: 'started_by_clear' }));
          else if (name === 'compact')
            add('workflow', 'context_pressure', at(n, e, { kind: 'compact_command', last_prompt_before: lastPrompt }));
          else if (name.includes(':') || !BUILTIN.has(name))
            add('setup', 'skills', at(n, e, { kind: 'typed_by_user', skill: name }));
          else add('setup', 'commands', at(n, e, { command: name }));
        }
        const origin = isRecord(e.origin) ? e.origin : {};
        const human =
          agent.id === 'main' &&
          text !== '' &&
          !e.isMeta &&
          !e.isCompactSummary &&
          (origin.kind ?? 'human') === 'human' &&
          !INJECTED.test(text);
        if (origin.kind === 'channel') add('delivery', 'silykat_messages', at(n, e, { text: cut(text, 200) }));
        if (human) {
          const after = [...actionsSincePrompt.reduce((m, a) => bump(m, a), new Map<string, number>())].sort(
            (a, b) => b[1] - a[1],
          );
          const p = at(n, e, {
            chars: text.length,
            source: orNull(e.promptSource),
            after_actions: after,
            text: cut(text, 600),
          });
          prompts.push(p);
          if (actionsSincePrompt.length)
            add('collaboration', 'corrections', {
              agent: p.agent,
              uuid: p.uuid,
              time: p.time,
              line: p.line,
              after_actions: after,
              text: p.text,
            });
          lastPrompt = { uuid: orNull(e.uuid), text: cut(text, 300) };
          actionsSincePrompt = [];
          bashSincePrompt = [];
        }
        firstUser = false;
      }
    }
  }

  for (const [command, uuids] of errorsByCommand)
    if (uuids.length >= 2) add('tools', 'repeated_failures', { command, failures: uuids.length, uuids });
  if (prompts.length) add('workflow', 'handoff', { ...prompts.at(-1), kind: 'last_prompt_of_session' });
  (sig.workflow ??= {}).repeated_requests = prompts; // every typed prompt: the report spots repeated intents
  for (const [family, names] of Object.entries(FAMILIES)) for (const name of names) (sig[family] ??= {})[name] ??= [];

  const skillsCalled = new Set(
    (sig.setup?.skills ?? []).map((o) => o.skill).filter((s): s is string => typeof s === 'string'),
  );
  times.sort();
  const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  return {
    schema: ANALYTICS_SCHEMA,
    session_id: sid,
    cwd: top(cwd)[0] ?? null,
    branches: top(branches),
    start: times[0] ?? null,
    end: times.at(-1) ?? null,
    claude_code_versions: [...versions].sort(),
    entrypoints: [...entrypoints].sort(),
    title: titles.at(-1) ?? null,
    custom_title: customTitles.at(-1) ?? null,
    agents: agents.map((a) => ({
      id: a.id,
      type: str(a.meta.agentType) ?? (a.id === 'main' ? 'main' : null),
      description: str(a.meta.description),
      launchedBy: str(a.meta.toolUseId),
      workflow: Boolean(a.meta.workflow),
      lines: a.lines.length,
      file: a.file,
    })),
    counts: {
      typed_prompts: prompts.length,
      lines: agents.reduce((s, a) => s + a.lines.length, 0),
      tool_calls: sorted(toolCalls),
      commands: sorted(commands),
      away_summaries: away,
      turns: turnMs.length,
      turn_duration_ms_total: turnMs.reduce((s, x) => s + x, 0),
      permission_modes: Object.fromEntries(permissionModes),
    },
    setup: {
      instructions_loaded: instructions,
      skills_available: [...skillsAvailable].sort(),
      skills_available_never_called: [...skillsAvailable].filter((s) => !skillsCalled.has(s)).sort(),
      skills_active_messages: sorted(skillsActive),
    },
    cost: {
      tokens_by_model: Object.fromEntries([...usage].map(([k, v]) => [k, Object.fromEntries(v)])),
      cost_state: costState,
      models: sorted(models),
    },
    signals: sig,
  };
}

import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { inFolders, localReviewHome, projectFolders, type RetroSession } from '@local-review/core';
import { runProcess, type Runner } from './retroAudit';

/**
 * Claude Code's sessions in a retro, through its `/insights` command. `/insights` keeps, for the
 * sessions of the whole machine, facts counted without a model (`usage-data/session-meta/<id>.json`)
 * and, for the longer ones, a summary written by a model (`usage-data/facets/<id>.json`). The retro
 * keeps only the sessions of its project and of its period; its HTML report, which mixes every
 * project, is never read.
 *
 * These files are internal to Claude Code: the reader depends on three fields of the facts only
 * (the session's id, its folder, its start). When one is missing (a new format), a small model is
 * asked which field holds it, from the names, types and shapes of the fields (never their values);
 * the answer, once it reads files the known formats do not, is kept on this machine, and that format
 * is read without a model from then on. The cache may mix formats (it keeps the summaries of older
 * versions): each file is read with the first format that reads it.
 */
export const INSIGHTS_COMMAND = '/insights';
export const INSIGHTS_SOURCE = 'Claude Code /insights';
export const INSIGHTS_TIMEOUT_MS = 15 * 60_000;
/** The model that finds the fields of a new format: a small one, the task is simple. */
export const FIELDS_MODEL = 'haiku';
export const FIELDS_FILE = 'insights-fields.json';

export type Key = 'session_id' | 'project_path' | 'start_time';
export const KEYS: readonly Key[] = ['session_id', 'project_path', 'start_time'];
/** The field of the facts that holds each key. */
export type FieldMap = Record<Key, string>;
export const DEFAULT_FIELDS: FieldMap = {
  session_id: 'session_id',
  project_path: 'project_path',
  start_time: 'start_time',
};

type Env = Record<string, string | undefined>;
type Facts = Record<string, unknown>;

export type InsightsRun =
  { kind: 'done'; costUsd: number | null; durationMs: number | null } | { kind: 'failed'; reason: string };

/** Runs `/insights` in a separate, non-interactive Claude Code: it brings its cache up to date. */
export async function runInsights(
  root: string,
  env: Env,
  run: Runner = runProcess,
  timeoutMs = INSIGHTS_TIMEOUT_MS,
): Promise<InsightsRun> {
  const claude = env.LR_CLAUDE_BIN?.trim() || 'claude';
  const r = await run(claude, ['-p', INSIGHTS_COMMAND, '--output-format', 'json'], { cwd: root, env, timeoutMs });
  if (r.timedOut) return { kind: 'failed', reason: `it took more than ${Math.round(timeoutMs / 60_000)} min` };
  let out: { is_error?: unknown; result?: unknown; total_cost_usd?: unknown; duration_ms?: unknown };
  try {
    out = JSON.parse(r.stdout) as typeof out;
  } catch {
    const why = (r.stderr || r.stdout).trim().split('\n').at(-1) ?? '';
    return { kind: 'failed', reason: `Claude Code ended with code ${r.code ?? '?'}${why ? `: ${why}` : ''}` };
  }
  if (out.is_error === true)
    return { kind: 'failed', reason: typeof out.result === 'string' ? out.result.split('\n')[0]! : 'an error' };
  return {
    kind: 'done',
    costUsd: typeof out.total_cost_usd === 'number' ? out.total_cost_usd : null,
    durationMs: typeof out.duration_ms === 'number' ? out.duration_ms : null,
  };
}

const fieldsFile = (env: Env) => join(localReviewHome(env), FIELDS_FILE);

/** The formats known on this machine: the known one first, then those learnt (`insights-fields.json`). */
export async function readFieldMaps(env: Env): Promise<FieldMap[]> {
  const maps: FieldMap[] = [{ ...DEFAULT_FIELDS }];
  try {
    const raw = JSON.parse(await readFile(fieldsFile(env), 'utf8')) as { formats?: unknown };
    for (const f of Array.isArray(raw.formats) ? raw.formats : []) {
      const m = f as Record<string, unknown>;
      if (KEYS.every((k) => typeof m[k] === 'string' && m[k])) maps.push(m as FieldMap);
    }
  } catch {
    // none learnt yet
  }
  return maps;
}

async function writeFieldMaps(env: Env, maps: readonly FieldMap[]): Promise<void> {
  const file = fieldsFile(env);
  await mkdir(localReviewHome(env), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ formats: maps.slice(1) }, null, 2) + '\n');
  await rename(tmp, file);
}

/** The keys of a session's facts, read with the first format that reads them, and that format. */
function keysWith(f: Facts, maps: readonly FieldMap[]) {
  for (const map of maps) {
    const k = keysOf(f, map);
    if (k) return { ...k, map };
  }
  return null;
}

/** The shape of a value, to describe a field without showing it. */
export function shapeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'list';
  if (typeof v === 'object') return 'object';
  if (typeof v === 'number' || typeof v === 'boolean') return typeof v;
  if (typeof v !== 'string') return typeof v;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) && !Number.isNaN(Date.parse(v))) return 'ISO date and time';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return 'UUID';
  if (isAbsolute(v) && !/\s{2}/.test(v) && !v.includes('\n')) return 'absolute path';
  return 'text';
}

/** The fields of some facts files, with the shapes of their values: never the values themselves. */
export function describeFields(files: readonly Facts[]): Record<string, string[]> {
  const out: Record<string, Set<string>> = {};
  for (const f of files) for (const [k, v] of Object.entries(f)) (out[k] ??= new Set()).add(shapeOf(v));
  return Object.fromEntries(Object.entries(out).map(([k, s]) => [k, [...s].sort()]));
}

/** The id, folder and start of a session's facts, read with `map`; `null` when one is missing or invalid. */
export function keysOf(f: Facts, map: FieldMap): { id: string; folder: string; start: string } | null {
  const id = f[map.session_id];
  const folder = f[map.project_path];
  const start = f[map.start_time];
  if (typeof id !== 'string' || !id.trim()) return null;
  if (typeof folder !== 'string' || !isAbsolute(folder)) return null;
  if (typeof start !== 'string' || Number.isNaN(Date.parse(start))) return null;
  return { id, folder, start: new Date(start).toISOString() };
}

/** Asks a small model which field holds each key, from the fields' names and shapes. */
export async function askFieldMap(
  files: readonly Facts[],
  root: string,
  env: Env,
  run: Runner = runProcess,
): Promise<Partial<FieldMap>> {
  const prompt = [
    'These are the fields of JSON files that describe sessions of an AI coding agent, with the shapes of their values (the values are not shown).',
    'For each of these keys, name the field that holds it: session_id (the id of the session), project_path (the folder the session was started in), start_time (when the session started).',
    'Answer with one JSON object only, like {"session_id": "<field>", "project_path": "<field>", "start_time": "<field>"}; use null for a key no field holds.',
    '',
    JSON.stringify(describeFields(files), null, 2),
  ].join('\n');
  const claude = env.LR_CLAUDE_BIN?.trim() || 'claude';
  const r = await run(
    claude,
    [
      '-p',
      prompt,
      '--model',
      FIELDS_MODEL,
      '--output-format',
      'json',
      '--permission-mode',
      'default',
      '--disallowedTools',
      'Bash',
      'Edit',
      'Write',
      'NotebookEdit',
      'Read',
      'Glob',
      'Grep',
      'WebFetch',
      'WebSearch',
    ],
    { cwd: root, env, timeoutMs: 120_000 },
  );
  try {
    const result = (JSON.parse(r.stdout) as { result?: unknown }).result;
    const text = typeof result === 'string' ? result : '';
    const json = /\{[\s\S]*\}/.exec(text)?.[0];
    const raw = json ? (JSON.parse(json) as Record<string, unknown>) : {};
    const map: Partial<FieldMap> = {};
    for (const k of KEYS) if (typeof raw[k] === 'string' && raw[k]) map[k] = raw[k];
    return map;
  } catch {
    return {};
  }
}

/** The sessions `/insights` has facts for, with their summary when there is one. */
export interface InsightsSession {
  id: string;
  folder: string;
  start: string;
  /** Its facts, without its keys (see `factsOf`). */
  facts: RetroSession['facts'];
  summary: Record<string, unknown> | null;
}

export interface InsightsRead {
  sessions: InsightsSession[];
  /** Facts files found: when there are some but no session could be read, the format is not understood. */
  files: number;
}

const readJson = async (file: string): Promise<Facts | null> => {
  try {
    const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Facts) : null;
  } catch {
    return null;
  }
};

/**
 * Reads the cache of `/insights` (`usageDir`): every session it has facts for. When the known fields
 * read none of them (or fewer than a field map a model finds), the new map is checked on the files and
 * kept for this machine.
 */
export async function readInsights(usageDir: string, root: string, env: Env, run?: Runner): Promise<InsightsRead> {
  const metaDir = join(usageDir, 'session-meta');
  const names = (await readdir(metaDir).catch(() => [] as string[])).filter((n) => n.endsWith('.json')).sort();
  const files: Facts[] = [];
  for (const n of names) {
    const f = await readJson(join(metaDir, n));
    if (f) files.push(f);
  }
  const maps = await readFieldMaps(env);
  const failing = files.filter((f) => !keysWith(f, maps));
  if (failing.length > 0) {
    // A new format? Ask once; keep the answer only when it reads files the known formats do not.
    const found = await askFieldMap(failing.slice(0, 20), root, env, run);
    const candidate = { ...DEFAULT_FIELDS, ...found };
    if (failing.some((f) => keysOf(f, candidate))) {
      maps.push(candidate);
      await writeFieldMaps(env, maps).catch(() => undefined);
    }
  }
  const sessions: InsightsSession[] = [];
  for (const f of files) {
    const k = keysWith(f, maps);
    if (!k) continue;
    const summary = await readJson(join(usageDir, 'facets', `${k.id}.json`));
    sessions.push({ id: k.id, folder: k.folder, start: k.start, facts: factsOf(f, k.map), summary });
  }
  return { sessions, files: files.length };
}

/** Facts kept for the analysis: the numbers and short texts, without the keys, lists or long texts. */
export function factsOf(f: Facts, map: FieldMap): RetroSession['facts'] {
  const skip = new Set<string>([map.session_id, map.project_path, map.start_time, 'transcript_mtime']);
  const out: RetroSession['facts'] = {};
  const put = (k: string, v: unknown) => {
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && v.trim()) out[k] = v.length > 300 ? `${v.slice(0, 299)}…` : v;
  };
  for (const [k, v] of Object.entries(f)) {
    if (skip.has(k) || Array.isArray(v)) continue;
    if (typeof v === 'object' && v !== null) for (const [k2, v2] of Object.entries(v)) put(`${k}.${k2}`, v2);
    else put(k, v);
  }
  return out;
}

export { inFolders, projectFolders };

/** Whether a start falls in a retro's period (`since` `null`: the whole history). */
export const inPeriod = (start: string, since: string | null, until: string): boolean =>
  (since === null || start >= since) && start <= until;

/** The sessions of a project and a period, as the retro keeps them. */
export async function projectSessions(
  usageDir: string,
  root: string,
  period: { since: string | null; until: string },
  env: Env,
  run?: Runner,
  exclude: ReadonlySet<string> = new Set(),
): Promise<{ sessions: RetroSession[]; files: number; read: number }> {
  const { sessions, files } = await readInsights(usageDir, root, env, run);
  const folders = await projectFolders(root, env);
  const kept = sessions
    .filter((s) => !exclude.has(s.id) && inFolders(s.folder, folders) && inPeriod(s.start, period.since, period.until))
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((s) => ({ id: s.id, start: s.start, folder: s.folder, facts: s.facts, summary: s.summary }));
  return { sessions: kept, files, read: sessions.length };
}

/**
 * The first folder and time of a transcript: the session's folder and start, and how Claude Code was
 * run (`entrypoint`, on the line with the folder: `cli`, `sdk-cli` for `claude -p`…), when written.
 */
async function transcriptStart(file: string): Promise<{ cwd: string; start: string; entrypoint?: string } | null> {
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let cwd: string | null = null;
  let start: string | null = null;
  let entrypoint: string | undefined;
  try {
    for await (const line of lines) {
      let e: { cwd?: unknown; timestamp?: unknown; entrypoint?: unknown };
      try {
        e = JSON.parse(line) as typeof e;
      } catch {
        continue;
      }
      if (cwd === null && typeof e.cwd === 'string') {
        cwd = e.cwd;
        if (typeof e.entrypoint === 'string') entrypoint = e.entrypoint;
      }
      if (start === null && typeof e.timestamp === 'string') start = e.timestamp;
      if (cwd !== null && start !== null) break;
    }
  } finally {
    lines.close();
  }
  return cwd !== null && start !== null && !Number.isNaN(Date.parse(start))
    ? { cwd, start: new Date(start).toISOString(), ...(entrypoint ? { entrypoint } : {}) }
    : null;
}

/** A conversation of Claude Code: its session, file, folder and start. */
export interface ProjectTranscript {
  id: string;
  file: string;
  cwd: string;
  start: string;
  /** How Claude Code was run, when written: `cli`, `sdk-cli` (`claude -p`, a program)… */
  entrypoint?: string;
}

/** Every Claude Code conversation kept in `claudeDir` (one file per session, sub-agents apart). */
export async function allTranscripts(claudeDir: string): Promise<ProjectTranscript[]> {
  const projects = join(claudeDir, 'projects');
  const out: ProjectTranscript[] = [];
  for (const dir of await readdir(projects).catch(() => [] as string[])) {
    const names = await readdir(join(projects, dir)).catch(() => [] as string[]);
    for (const name of names.filter((x) => x.endsWith('.jsonl'))) {
      const file = join(projects, dir, name);
      const s = await transcriptStart(file);
      if (s) out.push({ id: name.slice(0, -'.jsonl'.length), file, ...s });
    }
  }
  return out;
}

/**
 * The Claude Code sessions of a project in a period, from Claude Code's own conversations (one file
 * per session in `projects/<folder>/`, sub-agents apart): exact even before `/insights` runs. Oldest
 * first.
 */
export async function projectTranscripts(
  claudeDir: string,
  root: string,
  period: { since: string | null; until: string },
  env: Env,
): Promise<ProjectTranscript[]> {
  const folders = await projectFolders(root, env);
  return (await allTranscripts(claudeDir))
    .filter((t) => inFolders(t.cwd, folders) && inPeriod(t.start, period.since, period.until))
    .sort((a, b) => a.start.localeCompare(b.start));
}

/** How many Claude Code sessions a project had in a period (see `projectTranscripts`). */
export async function countSessions(
  claudeDir: string,
  root: string,
  period: { since: string | null; until: string },
  env: Env,
): Promise<number> {
  return (await projectTranscripts(claudeDir, root, period, env)).length;
}

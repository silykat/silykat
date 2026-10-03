import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isStoreRoot } from './agentView';
import { ulid } from './ids';
import { LOOSE_ROOT } from './sessions';
import { worktreeTopOf } from './topics';
import { STORE_DIR } from './types';

/**
 * Retros: the user and their agent look back at the review feedback of a period and decide how to
 * improve the agent's setup. Local Review keeps their journal, next to the comments of the project:
 *
 * ```text
 * .local-review/retros/<retro-id>.jsonl   one append-only journal per retro
 * .local-review/retros/preferences.jsonl  how the user wants their retros (append-only)
 * .local-review/retros/<retro-id>/        files written for the agents of a retro (regenerated)
 * ```
 *
 * Older versions of Local Review never read `retros/`: adding it changes nothing for them. Its
 * events carry their own version (`RETRO_SCHEMA_VERSION`).
 */
export const RETRO_SCHEMA_VERSION = 1;
export const RETROS_DIR = 'retros';

export type Column = 'keep' | 'remove' | 'improve';
export const COLUMNS: readonly Column[] = ['keep', 'remove', 'improve'];

/**
 * Where a change goes: the project's shared files (committed, for the whole team), the user's own
 * files for this project (not committed), or the user's files for every project.
 */
export type Target = 'project-shared' | 'project-personal' | 'user';
export const TARGETS: readonly Target[] = ['project-shared', 'project-personal', 'user'];

export type ProposalKind = 'rule' | 'hook' | 'skill' | 'command' | 'agent' | 'doc' | 'setting' | 'other';
export const PROPOSAL_KINDS: readonly ProposalKind[] = [
  'rule',
  'hook',
  'skill',
  'command',
  'agent',
  'doc',
  'setting',
  'other',
];

export type Decision = 'accepted' | 'modified' | 'excluded' | 'retargeted';
export const DECISIONS: readonly Decision[] = ['accepted', 'modified', 'excluded', 'retargeted'];

/** A thread cited as evidence, with the excerpt that shows it. */
export interface Evidence {
  thread: string;
  excerpt: string;
}

/** Numbers of a proposal, computed from its threads (never by a model). */
export interface Figures {
  threads: number;
  /** Threads the user reopened after the agent said it was done (or after resolving them). */
  reopened: number;
  /** Threads where the agent had to ask a question. */
  questions: number;
  /** The user's replies after an agent's reply, across the threads: rounds of back-and-forth. */
  rounds: number;
  /** First and last activity of the threads. */
  first: string;
  last: string;
}

/** A proposal as recorded, after the guard rails. */
export interface Proposal {
  /** `p1`, `p2`… in the order of the retro. */
  id: string;
  column: Column;
  subject: string;
  title: string;
  kind: ProposalKind;
  /** The file concerned: where the existing rule is, or where the change goes. */
  file: string;
  /** The existing rule (or setting, skill…) concerned, word for word, when there is one. */
  rule: string | null;
  /** The exact change (empty for "keep"). */
  change: string;
  /** The common cause, and what the change must avoid. */
  why: string;
  /** The single cause it addresses (one subject per proposal). */
  cause: string;
  evidence: Evidence[];
  figures: Figures;
  target: Target;
  targetWhy: string;
  /** Nothing tells which target is right: the user is asked to choose. */
  askTarget: boolean;
  confidence: number;
  recommendation: Decision;
  /** It was a "keep", but the user had to enforce the rule in these threads. */
  convertedFromKeep?: { threads: string[] };
  /** A subject the user excluded in an earlier retro, proposed again for new feedback. */
  reopens?: { retro: string; proposal: string; at: string; newThreads: string[] };
  /** A finding of the agent's own audit of its setup (stale, contradictory rules…), when it comes from one. */
  audit?: AuditFinding;
}

/** A finding of an audit of the agent's setup: where, and what is wrong there. */
export interface AuditFinding {
  /** The file, with its lines when known: `CLAUDE.md:2-3`. */
  location: string;
  finding: string;
}

/** A preference seen in a single thread: watched, not proposed. */
export interface WatchItem {
  id: string;
  subject: string;
  why: string;
  evidence: Evidence[];
}

/** What the guard rails left out, and why. */
export interface Dropped {
  subject: string;
  reason: string;
}

/** A label given to a thread by the classification step. */
export interface ThreadLabel {
  /** A category of `FEEDBACK_CATEGORIES`. */
  category: number;
  confidence?: number;
  /** How likely the feedback shows a project rule or fact missing from the rules files (0 to 1). */
  missingRule?: number;
  /** How likely the feedback points to a rule that exists but was not followed (0 to 1). */
  ignoredRule?: number;
}

/** The kinds of feedback a developer gives their coding agent, for the classification step. */
export const FEEDBACK_CATEGORIES: Readonly<Record<number, string>> = {
  1: 'misread request: the agent did something else than what was asked',
  2: "existing rule not followed: the project's rules files already say it, the agent broke it",
  3: 'project rule or knowledge missing: a project-specific fact or convention the agent could not know',
  4: 'convention ignored: naming, formatting, style, layout (general good practice, not a project rule)',
  5: 'unrequested change: the agent changed things outside the request',
  6: 'over-engineering or poor approach: too complex, wrong design',
  7: 'logic or functional defect: the code does not work as intended',
  8: 'missed edge case or validation',
  9: 'hallucinated API or missing domain knowledge',
  10: 'incomplete work: part of the request not done',
  11: 'claimed done without verifying: said it works or tests pass without checking, or weakened tests',
  12: 'context loss: forgot a decision or instruction given earlier',
  13: 'missing docs, comments or tests',
  14: 'not a defect: question, discussion, praise, or the reviewer was wrong',
};

/** The category "an existing rule was not followed". */
export const RULE_NOT_FOLLOWED = 2;

export interface RetroStore {
  root: string;
  origin: string;
  threads: number;
  bytes: number;
}

export interface Preference {
  id: string;
  body: string;
  at: string;
}

interface BaseRetroEvent {
  v: number;
  at: string;
}

export type RetroEvent = BaseRetroEvent &
  (
    | {
        type: 'retro.started';
        retroId: string;
        /** The project folder. */
        root: string;
        /** Start of the period (ISO), `null` for the whole history. */
        since: string | null;
        until: string;
        stores: RetroStore[];
        /** The threads of the period, read by the retro. */
        threads: string[];
        bytes: number;
        /** The retro preferences in force. */
        preferences: Preference[];
      }
    /** What the user said about the previous retro. */
    | { type: 'retro.feedback'; body: string }
    | { type: 'retro.classified'; by: string; labels: Record<string, ThreadLabel> }
    | { type: 'retro.proposed'; proposals: Proposal[]; watch: WatchItem[]; dropped: Dropped[] }
    | { type: 'retro.decided'; proposal: string; decision: Decision; target?: Target; note?: string }
    | { type: 'retro.applied'; proposal: string; files: string[] }
    /** A decision recorded by mistake (e.g. on the wrong proposal): undone, with its files changed. */
    | { type: 'retro.undone'; proposal: string }
    /**
     * The analysis read back the agent's conversation of a thread (`available`), or found it gone
     * (agents delete their conversations after a while).
     */
    | { type: 'retro.conversation'; thread: string; sessions: string[]; available: boolean }
    | { type: 'retro.finished' }
  );

export type PreferenceEvent = BaseRetroEvent &
  ({ type: 'preference.added'; id: string; body: string } | { type: 'preference.removed'; id: string });

const RETRO_EVENTS: ReadonlySet<string> = new Set<RetroEvent['type']>([
  'retro.started',
  'retro.feedback',
  'retro.classified',
  'retro.proposed',
  'retro.decided',
  'retro.applied',
  'retro.undone',
  'retro.conversation',
  'retro.finished',
]);
const PREFERENCE_EVENTS: ReadonlySet<string> = new Set<PreferenceEvent['type']>([
  'preference.added',
  'preference.removed',
]);

export interface DecisionRecord {
  decision: Decision;
  target?: Target;
  note?: string;
  at: string;
}

export interface ConversationRecord {
  sessions: string[];
  available: boolean;
  at: string;
}

/** A retro, folded from its journal. */
export interface RetroState {
  id: string;
  root: string;
  since: string | null;
  until: string;
  startedAt: string;
  stores: RetroStore[];
  threads: string[];
  bytes: number;
  preferences: Preference[];
  feedback: string[];
  classification: { by: string[]; labels: Record<string, ThreadLabel> } | null;
  proposals: Proposal[];
  watch: WatchItem[];
  dropped: Dropped[];
  /** The last decision on each proposal. */
  decisions: Record<string, DecisionRecord>;
  /** Files changed for each proposal. */
  applied: Record<string, string[]>;
  /** The threads whose agent conversation the analysis looked for: read back, or no longer available. */
  conversations: Record<string, ConversationRecord>;
  finishedAt: string | null;
  /** Written by a newer version of Local Review: never write to it. */
  readOnly: boolean;
  warnings: string[];
}

const RETRO_ID = /^rt_[0-9A-HJKMNP-TV-Z]{26}$/;
export const newRetroId = (): string => `rt_${ulid()}`;

/** Parses a retro or preferences journal, with the tolerance of the comment journals. */
function parseLines<E>(
  text: string,
  source: string,
  types: ReadonlySet<string>,
): { events: E[]; warnings: string[]; future: boolean } {
  const events: E[] = [];
  const warnings: string[] = [];
  let future = false;
  const end = text.lastIndexOf('\n');
  const lines = end === -1 ? [] : text.slice(0, end).split('\n');
  lines.forEach((line, i) => {
    if (line.trim() === '') return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      warnings.push(`${source}:${i + 1}: invalid JSON, line skipped`);
      return;
    }
    const e = raw as { v?: unknown; type?: unknown };
    if (typeof raw !== 'object' || raw === null || typeof e.v !== 'number' || typeof e.type !== 'string') {
      warnings.push(`${source}:${i + 1}: not an event, line skipped`);
      return;
    }
    if (e.v > RETRO_SCHEMA_VERSION) {
      future = true;
      return;
    }
    if (!types.has(e.type)) {
      warnings.push(`${source}:${i + 1}: unknown event type "${e.type}", line skipped`);
      return;
    }
    events.push(raw as E);
  });
  return { events, warnings, future };
}

/** Folds a retro journal; `null` without `retro.started`. */
export function foldRetro(events: readonly RetroEvent[], warnings: string[] = [], future = false): RetroState | null {
  const first = events[0];
  if (!first || first.type !== 'retro.started') return null;
  const r: RetroState = {
    id: first.retroId,
    root: first.root,
    since: first.since,
    until: first.until,
    startedAt: first.at,
    stores: first.stores,
    threads: first.threads,
    bytes: first.bytes,
    preferences: first.preferences ?? [],
    feedback: [],
    classification: null,
    proposals: [],
    watch: [],
    dropped: [],
    decisions: {},
    applied: {},
    conversations: {},
    finishedAt: null,
    readOnly: future,
    warnings,
  };
  for (const e of events.slice(1)) {
    switch (e.type) {
      case 'retro.feedback':
        r.feedback.push(e.body);
        break;
      case 'retro.classified': {
        // Classified in several passes (e.g. batches): later labels win.
        const c = (r.classification ??= { by: [], labels: {} });
        if (!c.by.includes(e.by)) c.by.push(e.by);
        Object.assign(c.labels, e.labels);
        break;
      }
      case 'retro.proposed':
        r.proposals = e.proposals;
        r.watch = e.watch;
        r.dropped = e.dropped;
        r.decisions = {};
        r.applied = {};
        break;
      case 'retro.decided':
        r.decisions[e.proposal] = {
          decision: e.decision,
          at: e.at,
          ...(e.target ? { target: e.target } : {}),
          ...(e.note ? { note: e.note } : {}),
        };
        break;
      case 'retro.applied':
        r.applied[e.proposal] = [...new Set([...(r.applied[e.proposal] ?? []), ...e.files])];
        break;
      case 'retro.undone':
        delete r.decisions[e.proposal];
        delete r.applied[e.proposal];
        break;
      case 'retro.conversation':
        // Read once is enough: a later failure to find it again does not undo it.
        if (!r.conversations[e.thread]?.available)
          r.conversations[e.thread] = { sessions: e.sessions, available: e.available, at: e.at };
        break;
      case 'retro.finished':
        r.finishedAt ??= e.at;
        break;
      case 'retro.started':
        break; // a second start is invalid
    }
  }
  return r;
}

/** Folds the preferences journal: the preferences in force, oldest first. */
export function foldPreferences(events: readonly PreferenceEvent[]): Preference[] {
  const prefs = new Map<string, Preference>();
  for (const e of events) {
    if (e.type === 'preference.added') prefs.set(e.id, { id: e.id, body: e.body, at: e.at });
    else prefs.delete(e.id);
  }
  return [...prefs.values()];
}

/**
 * The folder whose store keeps the retros of a project: the project folder when it holds a store
 * or is outside git; else the top of its git worktree, where the comments of the repository are.
 */
export async function retroHome(root: string, env: Record<string, string | undefined> = process.env): Promise<string> {
  if (root === LOOSE_ROOT) throw new Error('a retro is about a project folder, not the files outside any folder');
  const dir = resolve(root);
  if (isStoreRoot(dir, env)) return dir;
  return (await worktreeTopOf(dir)) ?? dir;
}

/** The retros of a project, and its retro preferences, kept in `<home>/.local-review/retros/`. */
export class RetroBook {
  readonly dir: string;

  constructor(readonly home: string) {
    this.dir = join(home, STORE_DIR, RETROS_DIR);
  }

  retroFile(id: string): string {
    if (!RETRO_ID.test(id)) throw new Error(`Invalid retro id: ${id}`);
    return join(this.dir, `${id}.jsonl`);
  }

  /** A folder for the files a retro writes for its agents. */
  async workDir(id: string): Promise<string> {
    if (!RETRO_ID.test(id)) throw new Error(`Invalid retro id: ${id}`);
    const dir = join(this.dir, id);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  get preferencesFile(): string {
    return join(this.dir, 'preferences.jsonl');
  }

  /** Every retro of this book, oldest first. */
  async list(): Promise<RetroState[]> {
    let files: string[];
    try {
      files = (await readdir(this.dir)).filter((f) => RETRO_ID.test(f.replace(/\.jsonl$/, '')) && f.endsWith('.jsonl'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const retros = await Promise.all(files.map((f) => this.read(f.slice(0, -'.jsonl'.length))));
    return retros
      .filter((r): r is RetroState => r !== null)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
  }

  async read(id: string): Promise<RetroState | null> {
    let text: string;
    try {
      text = await readFile(this.retroFile(id), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    const parsed = parseLines<RetroEvent>(text, `retros/${id}.jsonl`, RETRO_EVENTS);
    return foldRetro(parsed.events, parsed.warnings, parsed.future);
  }

  /** The retro, which must exist and accept writes. */
  async get(id: string): Promise<RetroState> {
    const r = await this.read(id);
    if (!r) throw new Error(`Retro not found: ${id}`);
    return r;
  }

  /** The last finished retro of the project folder `root`, if any. */
  async lastFinished(root: string): Promise<RetroState | null> {
    const done = (await this.list()).filter((r) => r.finishedAt !== null && r.root === resolve(root));
    return done.at(-1) ?? null;
  }

  async preferences(): Promise<Preference[]> {
    let text: string;
    try {
      text = await readFile(this.preferencesFile, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    return foldPreferences(parseLines<PreferenceEvent>(text, 'retros/preferences.jsonl', PREFERENCE_EVENTS).events);
  }

  async addPreference(body: string): Promise<Preference> {
    const text = body.trim();
    if (text === '') throw new Error('A preference cannot be empty');
    const ids = (await this.allPreferenceIds()).map((id) => Number(id.slice(1)));
    const id = `P${Math.max(0, ...ids) + 1}`;
    const at = new Date().toISOString();
    await this.append(this.preferencesFile, [
      { v: RETRO_SCHEMA_VERSION, type: 'preference.added', at, id, body: text },
    ]);
    return { id, body: text, at };
  }

  async removePreference(id: string): Promise<void> {
    if (!(await this.preferences()).some((p) => p.id === id)) throw new Error(`Preference not found: ${id}`);
    await this.append(this.preferencesFile, [
      { v: RETRO_SCHEMA_VERSION, type: 'preference.removed', at: new Date().toISOString(), id },
    ]);
  }

  /** Every preference id ever given, removed ones included: an id is never reused. */
  private async allPreferenceIds(): Promise<string[]> {
    try {
      const text = await readFile(this.preferencesFile, 'utf8');
      return parseLines<PreferenceEvent>(text, 'preferences', PREFERENCE_EVENTS).events.map((e) => e.id);
    } catch {
      return [];
    }
  }

  /** Starts a retro: its period and the threads it reads. */
  async start(scope: {
    root: string;
    since: string | null;
    until: string;
    stores: RetroStore[];
    threads: string[];
    bytes: number;
  }): Promise<RetroState> {
    const retroId = newRetroId();
    const preferences = await this.preferences();
    await this.append(this.retroFile(retroId), [
      {
        v: RETRO_SCHEMA_VERSION,
        type: 'retro.started',
        at: new Date().toISOString(),
        retroId,
        ...scope,
        root: resolve(scope.root),
        preferences,
      },
    ]);
    return this.get(retroId);
  }

  /** Appends events to a retro still in progress. */
  async record(id: string, events: readonly DistributiveOmit<RetroEvent, 'v' | 'at'>[]): Promise<RetroState> {
    const r = await this.get(id);
    if (r.readOnly) throw new Error(`Retro ${id} was written by a newer version of Local Review: update Local Review`);
    if (r.finishedAt) throw new Error(`Retro ${id} is finished`);
    const at = new Date().toISOString();
    await this.append(
      this.retroFile(id),
      events.map((e) => ({ v: RETRO_SCHEMA_VERSION, at, ...e }) as RetroEvent),
    );
    return this.get(id);
  }

  private async append(file: string, events: readonly (RetroEvent | PreferenceEvent)[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await appendFile(file, events.map((e) => JSON.stringify(e) + '\n').join(''), { flag: 'a' });
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

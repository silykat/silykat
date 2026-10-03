import {
  SCHEMA_VERSION,
  type AgentSessionRef,
  type Anchor,
  type Author,
  type BranchRef,
  type DeleteReason,
  type ThreadStatus,
} from './types';

interface BaseEvent {
  v: number;
  at: string;
  by: Author;
  /** Agent display name; set on every event written by an agent. */
  agent?: string;
}

export type ThreadEvent = BaseEvent &
  (
    | { type: 'thread.created'; threadId: string; anchor: Anchor; branch?: BranchRef | null }
    /**
     * `session` is optional: the agent's conversation the comment was written in (agent comments
     * only, when known). Older journals have none, and older versions ignore it.
     */
    | { type: 'comment.added'; commentId: string; body: string; reviewId: string | null; session?: AgentSessionRef }
    | { type: 'comment.edited'; commentId: string; body: string }
    | { type: 'comment.deleted'; commentId: string }
    | { type: 'status.changed'; status: ThreadStatus }
    | { type: 'anchor.updated'; anchor: Anchor }
    /** The branch was renamed (or the thread predates branches). */
    | { type: 'branch.changed'; branch: BranchRef | null }
    /** `reason` is optional: older journals have none (and older versions ignore it). */
    | { type: 'thread.deleted'; reason?: DeleteReason }
    /** Archived by the user (format version 2): hidden from the editor and agents, kept in the history. */
    | { type: 'thread.archived' }
    /** Brought back from the archive by the user (format version 2). */
    | { type: 'thread.unarchived' }
  );

export type ThreadEventType = ThreadEvent['type'];

const THREAD_EVENT_TYPES: ReadonlySet<string> = new Set<ThreadEventType>([
  'thread.created',
  'comment.added',
  'comment.edited',
  'comment.deleted',
  'status.changed',
  'anchor.updated',
  'branch.changed',
  'thread.deleted',
  'thread.archived',
  'thread.unarchived',
]);

/**
 * The format version an event needs, written in its `v`. The events of the first format keep
 * `v: 1`, so that an older version of Local Review still reads every thread that was never archived;
 * archiving needs version 2: an older version shows such a thread read-only, and says to update.
 */
export function eventVersion(type: ThreadEventType | ReviewEvent['type']): number {
  return type === 'thread.archived' || type === 'thread.unarchived' ? ARCHIVE_VERSION : FIRST_VERSION;
}

/** The first format: every event but archiving. */
export const FIRST_VERSION = 1;
/** The format that added archiving. */
export const ARCHIVE_VERSION = 2;

/** Events of a review journal (`reviews/<id>.jsonl`). */
export type ReviewEvent = BaseEvent &
  (
    | { type: 'review.started'; reviewId: string; branch?: BranchRef | null; path?: string | null }
    /** Its branch was renamed. */
    | { type: 'review.branch.changed'; branch: BranchRef | null }
    /** `summary` is the optional overall comment, like a GitHub review body. */
    | { type: 'review.submitted'; summary?: string }
    | { type: 'review.discarded' }
  );

const REVIEW_EVENT_TYPES: ReadonlySet<string> = new Set<ReviewEvent['type']>([
  'review.started',
  'review.branch.changed',
  'review.submitted',
  'review.discarded',
]);

export function serializeEvents(events: readonly (ThreadEvent | ReviewEvent)[]): string {
  return events.map((e) => JSON.stringify(e) + '\n').join('');
}

export interface ParsedJournal<E = ThreadEvent> {
  events: E[];
  warnings: string[];
  /** At least one event comes from a newer schema version. */
  futureVersion: boolean;
}

/**
 * Parses a thread journal. Invalid lines are skipped with a warning; a trailing
 * line without `\n` is an interrupted write and is ignored silently.
 */
export function parseJournal(text: string, source = 'journal'): ParsedJournal<ThreadEvent> {
  return parseEvents<ThreadEvent>(text, source, THREAD_EVENT_TYPES);
}

/** Parses a review journal, with the same tolerance as `parseJournal`. */
export function parseReviewJournal(text: string, source = 'review'): ParsedJournal<ReviewEvent> {
  return parseEvents<ReviewEvent>(text, source, REVIEW_EVENT_TYPES);
}

function parseEvents<E>(text: string, source: string, types: ReadonlySet<string>): ParsedJournal<E> {
  const events: E[] = [];
  const warnings: string[] = [];
  let futureVersion = false;

  const lastNewline = text.lastIndexOf('\n');
  const complete = lastNewline === -1 ? '' : text.slice(0, lastNewline);
  const lines = complete === '' ? [] : complete.split('\n');

  lines.forEach((line, i) => {
    if (line.trim() === '') return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      warnings.push(`${source}:${i + 1}: invalid JSON, line skipped`);
      return;
    }
    if (!isRecord(raw) || typeof raw.v !== 'number' || typeof raw.type !== 'string') {
      warnings.push(`${source}:${i + 1}: not an event, line skipped`);
      return;
    }
    if (raw.v > SCHEMA_VERSION) {
      futureVersion = true;
      return;
    }
    // Journals written before the format became agent-agnostic (pre-release) used `by: "claude"`.
    if (raw.by === 'claude') {
      raw.by = 'agent';
      raw.agent ??= 'Claude';
    }
    if (!types.has(raw.type)) {
      warnings.push(`${source}:${i + 1}: unknown event type "${raw.type}", line skipped`);
      return;
    }
    events.push(raw as unknown as E);
  });

  return { events, warnings, futureVersion };
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

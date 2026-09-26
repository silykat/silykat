import { SCHEMA_VERSION, type Anchor, type Author, type ThreadStatus } from './types';

interface BaseEvent {
  v: number;
  at: string;
  by: Author;
}

export type ThreadEvent = BaseEvent &
  (
    | { type: 'thread.created'; threadId: string; anchor: Anchor }
    | { type: 'comment.added'; commentId: string; body: string; reviewId: string | null }
    | { type: 'comment.edited'; commentId: string; body: string }
    | { type: 'comment.deleted'; commentId: string }
    | { type: 'status.changed'; status: ThreadStatus }
    | { type: 'anchor.updated'; anchor: Anchor }
    | { type: 'thread.deleted' }
  );

export type ThreadEventType = ThreadEvent['type'];

const THREAD_EVENT_TYPES: ReadonlySet<string> = new Set<ThreadEventType>([
  'thread.created',
  'comment.added',
  'comment.edited',
  'comment.deleted',
  'status.changed',
  'anchor.updated',
  'thread.deleted',
]);

export function serializeEvents(events: readonly ThreadEvent[]): string {
  return events.map((e) => JSON.stringify(e) + '\n').join('');
}

export interface ParsedJournal {
  events: ThreadEvent[];
  warnings: string[];
  /** At least one event comes from a newer schema version. */
  futureVersion: boolean;
}

/**
 * Parses a JSONL journal. Invalid lines are skipped with a warning; a trailing
 * line without `\n` is an interrupted write and is ignored silently.
 */
export function parseJournal(text: string, source = 'journal'): ParsedJournal {
  const events: ThreadEvent[] = [];
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
    if (!THREAD_EVENT_TYPES.has(raw.type)) {
      warnings.push(`${source}:${i + 1}: unknown event type "${raw.type}", line skipped`);
      return;
    }
    events.push(raw as unknown as ThreadEvent);
  });

  return { events, warnings, futureVersion };
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

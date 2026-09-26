import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseJournal, serializeEvents, type ThreadEvent } from './events';
import { foldThread } from './fold';
import { newCommentId, newThreadId } from './ids';
import { SCHEMA_VERSION, STORE_DIR, type Anchor, type Author, type ThreadState, type ThreadStatus } from './types';

export interface NewComment {
  author: Author;
  body: string;
  reviewId: string | null;
}

export interface ThreadLoadResult {
  /** `null` when the thread does not exist or its journal is unusable. Deleted threads are returned with `deleted: true`. */
  state: ThreadState | null;
  warnings: string[];
}

export interface LoadResult {
  threads: ThreadState[];
  warnings: string[];
}

/** File-based store rooted at `<root>/.local-review/`. All writes are appends of whole events. */
export class Store {
  readonly dir: string;

  constructor(readonly root: string) {
    this.dir = join(root, STORE_DIR);
  }

  get threadsDir(): string {
    return join(this.dir, 'threads');
  }

  threadFile(threadId: string): string {
    // Ids come from the command line too: never let one escape the store directory.
    if (!THREAD_ID.test(threadId)) throw new Error(`Invalid thread id: ${threadId}`);
    return join(this.threadsDir, `${threadId}.jsonl`);
  }

  /** Thread id of a journal file name, or `null` if the name is not a thread journal. */
  static threadIdOf(fileName: string): string | null {
    const id = fileName.endsWith('.jsonl') ? fileName.slice(0, -'.jsonl'.length) : '';
    return THREAD_ID.test(id) ? id : null;
  }

  /** Loads every non-deleted thread. A missing store is simply empty: reading never creates it. */
  async loadAll(): Promise<LoadResult> {
    const warnings: string[] = [];
    let files: string[];
    try {
      files = (await readdir(this.threadsDir)).filter((f) => f.endsWith('.jsonl')).sort();
    } catch (err) {
      if (isNotFound(err)) return { threads: [], warnings };
      throw err;
    }

    const threads: ThreadState[] = [];
    for (const file of files) {
      const { state, warnings: w } = await this.readJournal(join(this.threadsDir, file), `threads/${file}`);
      warnings.push(...w);
      if (state && !state.deleted) threads.push(state);
    }
    return { threads, warnings };
  }

  async loadThread(threadId: string): Promise<ThreadLoadResult> {
    try {
      return await this.readJournal(this.threadFile(threadId), `threads/${threadId}.jsonl`);
    } catch (err) {
      if (isNotFound(err)) return { state: null, warnings: [] };
      throw err;
    }
  }

  /**
   * Adds a comment, optionally changing the status in the same write so that readers never
   * observe the comment without its status.
   */
  async addComment(threadId: string, c: NewComment, opts: { status?: ThreadStatus } = {}): Promise<ThreadState> {
    const body = c.body.trim();
    if (body === '') throw new Error('Comment body is empty');
    if (opts.status) assertCanSetStatus(opts.status, c.author);
    await this.writableThread(threadId);

    const at = new Date().toISOString();
    const events: ThreadEvent[] = [
      { v: SCHEMA_VERSION, type: 'comment.added', at, by: c.author, commentId: newCommentId(), body, reviewId: c.reviewId },
    ];
    if (opts.status) events.push({ v: SCHEMA_VERSION, type: 'status.changed', at, by: c.author, status: opts.status });
    return this.appendAndReload(threadId, events);
  }

  async setStatus(threadId: string, status: ThreadStatus, by: Author): Promise<ThreadState> {
    assertCanSetStatus(status, by);
    await this.writableThread(threadId);
    const event: ThreadEvent = { v: SCHEMA_VERSION, type: 'status.changed', at: new Date().toISOString(), by, status };
    return this.appendAndReload(threadId, [event]);
  }

  private async writableThread(threadId: string): Promise<ThreadState> {
    const { state } = await this.loadThread(threadId);
    if (!state || state.deleted) throw new Error(`Thread not found: ${threadId}`);
    if (state.readOnly) throw new Error(`Thread ${threadId} was written by a newer version and is read-only`);
    return state;
  }

  private async appendAndReload(threadId: string, events: ThreadEvent[]): Promise<ThreadState> {
    await appendFile(this.threadFile(threadId), serializeEvents(events), { flag: 'a' });
    const { state } = await this.loadThread(threadId);
    if (!state) throw new Error(`Thread vanished while writing: ${threadId}`);
    return state;
  }

  private async readJournal(file: string, label: string): Promise<ThreadLoadResult> {
    const text = await readFile(file, 'utf8');
    const parsed = parseJournal(text, label);
    const state = foldThread(parsed.events, { futureVersion: parsed.futureVersion });
    const warnings = [...parsed.warnings];
    if (!state) warnings.push(`${label}: no thread.created event, file skipped`);
    return { state, warnings };
  }

  async createThread(anchor: Anchor, first: NewComment): Promise<ThreadState> {
    const body = first.body.trim();
    if (body === '') throw new Error('Comment body is empty');
    await this.ensureInitialized();

    const threadId = newThreadId();
    const at = new Date().toISOString();
    const events: ThreadEvent[] = [
      { v: SCHEMA_VERSION, type: 'thread.created', at, by: first.author, threadId, anchor },
      {
        v: SCHEMA_VERSION,
        type: 'comment.added',
        at,
        by: first.author,
        commentId: newCommentId(),
        body,
        reviewId: first.reviewId,
      },
    ];
    // One write for both events: the thread never exists half-created.
    await appendFile(this.threadFile(threadId), serializeEvents(events), { flag: 'a' });
    const state = foldThread(events);
    if (!state) throw new Error('unreachable: freshly created thread failed to fold');
    return state;
  }

  private async ensureInitialized(): Promise<void> {
    await mkdir(this.threadsDir, { recursive: true });
    await mkdir(join(this.dir, 'reviews'), { recursive: true });
    try {
      await writeFile(join(this.dir, 'schema-version'), `${SCHEMA_VERSION}\n`, { flag: 'wx' });
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
    }
  }
}

const THREAD_ID = /^t_[0-9A-HJKMNP-TV-Z]{26}$/;

/** Only the user resolves a thread (D06). */
function assertCanSetStatus(status: ThreadStatus, by: Author): void {
  if (status === 'resolved' && by !== 'user') throw new Error('Only the user can resolve a thread');
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function isAlreadyExists(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'EEXIST';
}

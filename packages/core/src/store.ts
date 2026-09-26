import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseJournal, serializeEvents, type ThreadEvent } from './events';
import { foldThread } from './fold';
import { newCommentId, newThreadId } from './ids';
import { SCHEMA_VERSION, STORE_DIR, type Anchor, type Author, type ThreadState, type ThreadStatus } from './types';

export interface NewComment {
  author: Author;
  /** Required when `author` is `agent`: the agent's display name (e.g. "Claude"). */
  agent?: string;
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
   *
   * A published reply from the user hands the thread back to the agent: unless a status is
   * given, a thread that is `needs-info`, `addressed` or `resolved` goes back to `open` (D12).
   */
  async addComment(threadId: string, c: NewComment, opts: { status?: ThreadStatus } = {}): Promise<ThreadState> {
    const body = c.body.trim();
    if (body === '') throw new Error('Comment body is empty');
    if (opts.status) assertCanSetStatus(opts.status, c.author);
    const current = await this.writableThread(threadId);

    const who = actor(c.author, c.agent);
    const reopens = c.author === 'user' && c.reviewId === null && current.status !== 'open';
    const status = opts.status ?? (reopens ? 'open' : undefined);
    const at = new Date().toISOString();
    const events: ThreadEvent[] = [
      { v: SCHEMA_VERSION, type: 'comment.added', at, ...who, commentId: newCommentId(), body, reviewId: c.reviewId },
    ];
    if (status) events.push({ v: SCHEMA_VERSION, type: 'status.changed', at, ...who, status });
    return this.appendAndReload(threadId, events);
  }

  async setStatus(threadId: string, status: ThreadStatus, by: Author, agent?: string): Promise<ThreadState> {
    assertCanSetStatus(status, by);
    const who = actor(by, agent);
    await this.writableThread(threadId);
    const event: ThreadEvent = { v: SCHEMA_VERSION, type: 'status.changed', at: new Date().toISOString(), ...who, status };
    return this.appendAndReload(threadId, [event]);
  }

  /** Records where the thread's code now is (after the file changed). */
  async updateAnchor(threadId: string, anchor: Anchor, by: Author, agent?: string): Promise<ThreadState> {
    const who = actor(by, agent);
    await this.writableThread(threadId);
    const event: ThreadEvent = { v: SCHEMA_VERSION, type: 'anchor.updated', at: new Date().toISOString(), ...who, anchor };
    return this.appendAndReload(threadId, [event]);
  }

  /** Edits a comment. Only its author can edit it. */
  async editComment(threadId: string, commentId: string, body: string, by: Author, agent?: string): Promise<ThreadState> {
    const text = body.trim();
    if (text === '') throw new Error('Comment body is empty');
    const who = actor(by, agent);
    const current = await this.writableThread(threadId);
    assertOwnComment(current, commentId, by);
    if (current.comments.find((c) => c.id === commentId)!.body === text) return current;
    const event: ThreadEvent = { v: SCHEMA_VERSION, type: 'comment.edited', at: new Date().toISOString(), ...who, commentId, body: text };
    return this.appendAndReload(threadId, [event]);
  }

  /**
   * Deletes a comment. Only its author can delete it. Deleting the last comment deletes the
   * thread too, in the same write: a thread never exists without comments.
   */
  async deleteComment(threadId: string, commentId: string, by: Author, agent?: string): Promise<ThreadState> {
    const who = actor(by, agent);
    const current = await this.writableThread(threadId);
    assertOwnComment(current, commentId, by);
    const at = new Date().toISOString();
    const events: ThreadEvent[] = [{ v: SCHEMA_VERSION, type: 'comment.deleted', at, ...who, commentId }];
    if (current.comments.length === 1) events.push({ v: SCHEMA_VERSION, type: 'thread.deleted', at, ...who });
    return this.appendAndReload(threadId, events);
  }

  /**
   * Deletes a whole thread, agent replies included. Only the user can. The journal keeps its
   * history (append-only): the thread is simply never shown again.
   */
  async deleteThread(threadId: string, by: Author): Promise<ThreadState> {
    if (by !== 'user') throw new Error('Only the user can delete a thread');
    await this.writableThread(threadId);
    const event: ThreadEvent = { v: SCHEMA_VERSION, type: 'thread.deleted', at: new Date().toISOString(), by };
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

    const who = actor(first.author, first.agent);
    const threadId = newThreadId();
    const at = new Date().toISOString();
    const events: ThreadEvent[] = [
      { v: SCHEMA_VERSION, type: 'thread.created', at, ...who, threadId, anchor },
      {
        v: SCHEMA_VERSION,
        type: 'comment.added',
        at,
        ...who,
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

/** `by` and `agent` fields of an event. Agents must always say who they are. */
function actor(by: Author, agent: string | undefined): { by: Author; agent?: string } {
  if (by === 'user') return { by };
  const name = agent?.trim();
  if (!name) throw new Error('An agent must give its name');
  return { by, agent: name };
}

function assertOwnComment(thread: ThreadState, commentId: string, by: Author): void {
  const comment = thread.comments.find((c) => c.id === commentId);
  if (!comment) throw new Error(`Comment not found: ${commentId}`);
  if (comment.author !== by) throw new Error('You can only change your own comments');
}

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

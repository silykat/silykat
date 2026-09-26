import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseJournal, serializeEvents, type ThreadEvent } from './events';
import { foldThread } from './fold';
import { newCommentId, newThreadId } from './ids';
import { SCHEMA_VERSION, STORE_DIR, type Anchor, type Author, type ThreadState } from './types';

export interface NewComment {
  author: Author;
  body: string;
  reviewId: string | null;
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
    return join(this.threadsDir, `${threadId}.jsonl`);
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
      const text = await readFile(join(this.threadsDir, file), 'utf8');
      const parsed = parseJournal(text, `threads/${file}`);
      warnings.push(...parsed.warnings);
      const state = foldThread(parsed.events, { futureVersion: parsed.futureVersion });
      if (!state) {
        warnings.push(`threads/${file}: no thread.created event, file skipped`);
        continue;
      }
      if (!state.deleted) threads.push(state);
    }
    return { threads, warnings };
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

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function isAlreadyExists(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'EEXIST';
}

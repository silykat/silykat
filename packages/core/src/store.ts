import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseJournal, parseReviewJournal, serializeEvents, type ReviewEvent, type ThreadEvent } from './events';
import { foldReview, foldThread } from './fold';
import { newCommentId, newReviewId, newThreadId } from './ids';
import {
  branchKey,
  SCHEMA_VERSION,
  STORE_DIR,
  type Anchor,
  type Author,
  type BranchRef,
  type ReviewState,
  type ThreadState,
  type ThreadStatus,
} from './types';

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
  reviews: ReviewState[];
  warnings: string[];
}

type Reviews = ReadonlyMap<string, ReviewState>;

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

  get reviewsDir(): string {
    return join(this.dir, 'reviews');
  }

  reviewFile(reviewId: string): string {
    if (!REVIEW_ID.test(reviewId)) throw new Error(`Invalid review id: ${reviewId}`);
    return join(this.reviewsDir, `${reviewId}.jsonl`);
  }

  /** Thread id of a journal file name, or `null` if the name is not a thread journal. */
  static threadIdOf(fileName: string): string | null {
    const id = fileName.endsWith('.jsonl') ? fileName.slice(0, -'.jsonl'.length) : '';
    return THREAD_ID.test(id) ? id : null;
  }

  /** Loads every non-deleted thread and every review. A missing store is simply empty: reading never creates it. */
  async loadAll(): Promise<LoadResult> {
    const { reviews, warnings } = await this.loadReviews();
    const threads: ThreadState[] = [];
    for (const file of await listJournals(this.threadsDir)) {
      const { state, warnings: w } = await this.readJournal(join(this.threadsDir, file), `threads/${file}`, reviews);
      warnings.push(...w);
      if (state && !state.deleted) threads.push(state);
    }
    return { threads, reviews: [...reviews.values()], warnings };
  }

  async loadThread(threadId: string): Promise<ThreadLoadResult> {
    const { reviews } = await this.loadReviews();
    try {
      return await this.readJournal(this.threadFile(threadId), `threads/${threadId}.jsonl`, reviews);
    } catch (err) {
      if (isNotFound(err)) return { state: null, warnings: [] };
      throw err;
    }
  }

  async loadReviews(): Promise<{ reviews: Map<string, ReviewState>; warnings: string[] }> {
    const reviews = new Map<string, ReviewState>();
    const warnings: string[] = [];
    for (const file of await listJournals(this.reviewsDir)) {
      const label = `reviews/${file}`;
      const parsed = parseReviewJournal(await readFile(join(this.reviewsDir, file), 'utf8'), label);
      warnings.push(...parsed.warnings);
      const state = foldReview(parsed.events);
      if (state) reviews.set(state.id, state);
      else warnings.push(`${label}: no review.started event, file skipped`);
    }
    return { reviews, warnings };
  }

  /** The review in progress, if any. There is at most one per store (V1). */
  /** The review in progress for a branch (`null`: outside git), if any. */
  async activeReview(branch: BranchRef | null = null): Promise<ReviewState | null> {
    const { reviews } = await this.loadReviews();
    return latestActive(reviews, branch);
  }

  /** Every review in progress: at most one per branch. */
  async activeReviews(): Promise<ReviewState[]> {
    const { reviews } = await this.loadReviews();
    const latest = new Map<string, ReviewState>();
    for (const r of reviews.values()) {
      if (r.state !== 'active') continue;
      const current = latest.get(branchKey(r.branch));
      if (!current || r.startedAt > current.startedAt) latest.set(branchKey(r.branch), r);
    }
    return [...latest.values()];
  }

  /** Starts a review of a branch, or returns the one already in progress there. */
  async startReview(branch: BranchRef | null = null): Promise<ReviewState> {
    const active = await this.activeReview(branch);
    if (active) return active;
    await this.ensureInitialized();
    const reviewId = newReviewId();
    const event: ReviewEvent = {
      v: SCHEMA_VERSION,
      type: 'review.started',
      at: new Date().toISOString(),
      by: 'user',
      reviewId,
      ...(branch ? { branch } : {}),
    };
    await appendFile(this.reviewFile(reviewId), serializeEvents([event]), { flag: 'a' });
    return foldReview([event])!;
  }

  /** A review in progress follows its renamed branch. */
  async setReviewBranch(reviewId: string, branch: BranchRef | null): Promise<void> {
    await this.assertActiveReview(reviewId);
    const event: ReviewEvent = {
      v: SCHEMA_VERSION,
      type: 'review.branch.changed',
      at: new Date().toISOString(),
      by: 'user',
      branch,
    };
    await appendFile(this.reviewFile(reviewId), serializeEvents([event]), { flag: 'a' });
  }

  async submitReview(reviewId: string, summary?: string): Promise<ReviewState> {
    await this.assertActiveReview(reviewId);
    const { threads: before } = await this.loadAll();
    const text = summary?.trim();
    const event: ReviewEvent = {
      v: SCHEMA_VERSION,
      type: 'review.submitted',
      at: new Date().toISOString(),
      by: 'user',
      ...(text ? { summary: text } : {}),
    };
    await appendFile(this.reviewFile(reviewId), serializeEvents([event]), { flag: 'a' });

    for (const t of before) {
      const repliesInReview = t.comments.some((c) => c.reviewId === reviewId && c.author === 'user');
      if (repliesInReview && t.status !== 'open' && !t.readOnly) await this.setStatus(t.id, 'open', 'user');
    }
    const { reviews } = await this.loadReviews();
    return reviews.get(reviewId)!;
  }

  /** Abandons a review: its draft comments are dropped, and threads holding only drafts disappear. */
  async discardReview(reviewId: string): Promise<ReviewState> {
    await this.assertActiveReview(reviewId);
    const event: ReviewEvent = {
      v: SCHEMA_VERSION,
      type: 'review.discarded',
      at: new Date().toISOString(),
      by: 'user',
    };
    await appendFile(this.reviewFile(reviewId), serializeEvents([event]), { flag: 'a' });
    const { reviews } = await this.loadReviews();
    return reviews.get(reviewId)!;
  }

  /**
   * Adds a comment, optionally changing the status in the same write so that readers never
   * observe the comment without its status.
   *
   * A published reply from the user hands the thread back to the agent: unless a status is
   * given, a thread that is `needs-info`, `addressed` or `resolved` goes back to `open`.
   */
  async addComment(threadId: string, c: NewComment, opts: { status?: ThreadStatus } = {}): Promise<ThreadState> {
    const body = c.body.trim();
    if (body === '') throw new Error('Comment body is empty');
    if (opts.status) assertCanSetStatus(opts.status, c.author);
    if (c.reviewId !== null) await this.assertCanDraft(c.reviewId, c.author);
    const current = await this.writableThread(threadId, c.author);

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
    await this.writableThread(threadId, by);
    const event: ThreadEvent = {
      v: SCHEMA_VERSION,
      type: 'status.changed',
      at: new Date().toISOString(),
      ...who,
      status,
    };
    return this.appendAndReload(threadId, [event]);
  }

  /** Records where the thread's code now is (after the file changed). */
  async updateAnchor(threadId: string, anchor: Anchor, by: Author, agent?: string): Promise<ThreadState> {
    const who = actor(by, agent);
    await this.writableThread(threadId, by);
    const event: ThreadEvent = {
      v: SCHEMA_VERSION,
      type: 'anchor.updated',
      at: new Date().toISOString(),
      ...who,
      anchor,
    };
    return this.appendAndReload(threadId, [event]);
  }

  /** A thread follows its renamed branch (or is given one). */
  async setBranch(threadId: string, branch: BranchRef | null): Promise<ThreadState> {
    await this.writableThread(threadId, 'user');
    const event: ThreadEvent = {
      v: SCHEMA_VERSION,
      type: 'branch.changed',
      at: new Date().toISOString(),
      by: 'user',
      branch,
    };
    return this.appendAndReload(threadId, [event]);
  }

  /** Edits a comment. Only its author can edit it. */
  async editComment(
    threadId: string,
    commentId: string,
    body: string,
    by: Author,
    agent?: string,
  ): Promise<ThreadState> {
    const text = body.trim();
    if (text === '') throw new Error('Comment body is empty');
    const who = actor(by, agent);
    const current = await this.writableThread(threadId, by);
    assertOwnComment(current, commentId, by);
    if (current.comments.find((c) => c.id === commentId)!.body === text) return current;
    const event: ThreadEvent = {
      v: SCHEMA_VERSION,
      type: 'comment.edited',
      at: new Date().toISOString(),
      ...who,
      commentId,
      body: text,
    };
    return this.appendAndReload(threadId, [event]);
  }

  /**
   * Deletes a comment. Only its author can delete it. Deleting the last comment deletes the
   * thread too, in the same write: a thread never exists without comments.
   */
  async deleteComment(threadId: string, commentId: string, by: Author, agent?: string): Promise<ThreadState> {
    const who = actor(by, agent);
    const current = await this.writableThread(threadId, by);
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
    await this.writableThread(threadId, by);
    const event: ThreadEvent = { v: SCHEMA_VERSION, type: 'thread.deleted', at: new Date().toISOString(), by };
    return this.appendAndReload(threadId, [event]);
  }

  /** A thread `by` may write to. Agents never see threads that only hold drafts. */
  private async writableThread(threadId: string, by: Author): Promise<ThreadState> {
    const { state } = await this.loadThread(threadId);
    if (!state || state.deleted || (by === 'agent' && !state.hasPublished)) {
      throw new Error(`Thread not found: ${threadId}`);
    }
    if (state.readOnly) throw new Error(`Thread ${threadId} was written by a newer version and is read-only`);
    return state;
  }

  private async appendAndReload(threadId: string, events: ThreadEvent[]): Promise<ThreadState> {
    await appendFile(this.threadFile(threadId), serializeEvents(events), { flag: 'a' });
    const { state } = await this.loadThread(threadId);
    if (!state) throw new Error(`Thread vanished while writing: ${threadId}`);
    return state;
  }

  /** Drafts belong to the user: only the user writes them, and only in the review in progress. */
  private async assertCanDraft(reviewId: string, by: Author): Promise<void> {
    if (by !== 'user') throw new Error('Only the user writes draft comments');
    await this.assertActiveReview(reviewId);
  }

  private async assertActiveReview(reviewId: string): Promise<void> {
    const { reviews } = await this.loadReviews();
    const review = reviews.get(reviewId);
    if (!review) throw new Error(`Review not found: ${reviewId}`);
    if (review.state !== 'active') throw new Error(`Review ${reviewId} is already ${review.state}`);
  }

  private async readJournal(file: string, label: string, reviews: Reviews): Promise<ThreadLoadResult> {
    const text = await readFile(file, 'utf8');
    const parsed = parseJournal(text, label);
    const state = foldThread(parsed.events, { futureVersion: parsed.futureVersion, reviews });
    const warnings = [...parsed.warnings];
    if (!state) warnings.push(`${label}: no thread.created event, file skipped`);
    return { state, warnings };
  }

  async createThread(anchor: Anchor, first: NewComment, branch: BranchRef | null = null): Promise<ThreadState> {
    const body = first.body.trim();
    if (body === '') throw new Error('Comment body is empty');
    if (first.reviewId !== null) await this.assertCanDraft(first.reviewId, first.author);
    await this.ensureInitialized();

    const who = actor(first.author, first.agent);
    const threadId = newThreadId();
    const at = new Date().toISOString();
    const events: ThreadEvent[] = [
      { v: SCHEMA_VERSION, type: 'thread.created', at, ...who, threadId, anchor, ...(branch ? { branch } : {}) },
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
    const { reviews } = await this.loadReviews();
    const state = foldThread(events, { reviews });
    if (!state) throw new Error('unreachable: freshly created thread failed to fold');
    return state;
  }

  private async ensureInitialized(): Promise<void> {
    await mkdir(this.threadsDir, { recursive: true });
    await mkdir(this.reviewsDir, { recursive: true });
    try {
      await writeFile(join(this.dir, 'schema-version'), `${SCHEMA_VERSION}\n`, { flag: 'wx' });
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
    }
  }
}

const THREAD_ID = /^t_[0-9A-HJKMNP-TV-Z]{26}$/;
const REVIEW_ID = /^r_[0-9A-HJKMNP-TV-Z]{26}$/;

/** Journal file names of a directory, sorted; empty when the directory does not exist. */
async function listJournals(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort();
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
}

function latestActive(reviews: Reviews, branch: BranchRef | null): ReviewState | null {
  const active = [...reviews.values()].filter((r) => r.state === 'active' && branchKey(r.branch) === branchKey(branch));
  active.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
  return active[0] ?? null;
}

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

/** Only the user resolves a thread. */
function assertCanSetStatus(status: ThreadStatus, by: Author): void {
  if (status === 'resolved' && by !== 'user') throw new Error('Only the user can resolve a thread');
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function isAlreadyExists(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'EEXIST';
}

import { appendFile, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * A running agent session known to Local Review. Written by the agent's adapter (e.g. the Claude
 * Code plugin's hooks), read by the VS Code extension to know where to send the comments.
 */
export interface SessionRecord {
  /** The agent's own session id. */
  id: string;
  /** Display name of the agent, e.g. "Claude". */
  agent: string;
  /** Folder the session was started in. */
  cwd: string;
  /** Folder the session works in now, when it moved (e.g. `cd` into a worktree). */
  workingDir?: string | null;
  /** Git branch of the folder it works in, if any. */
  branch: string | null;
  /** Process to watch: when it is gone, so is the session. `null` when unknown. */
  pid: number | null;
  startedAt: string;
  /**
   * Whether deliveries reach the agent on their own, even while it waits for the user (for Claude
   * Code: the session was launched with the Local Review channel). `null` when unknown.
   */
  push?: boolean | null;
  /** When `push` is not true: the command that launches the agent with push on, shown to the user. */
  pushCommand?: string | null;
}

/** Where the last read of an inbox stopped. */
export interface InboxCursor {
  file: number;
  offset: number;
}

/** "The user published these threads": what the agent of a session is asked to process. */
export interface Delivery {
  id: string;
  at: string;
  /** Folder holding the `.local-review/` store of the threads. */
  root: string;
  /** A new thread, a reply outside a review, or a submitted review. */
  kind: 'comment' | 'reply' | 'review';
  threadIds: string[];
  reviewId?: string;
}

/** A session, with the files it wrote (absolute paths, most recent last). */
export interface Session extends SessionRecord {
  touched: string[];
  /** When it last wrote each of those files (ISO dates). */
  writtenAt?: Record<string, string>;
}

/** Local Review's per-machine folder: `$LOCAL_REVIEW_HOME`, or `~/.local-review`. */
export function localReviewHome(env: Record<string, string | undefined> = process.env): string {
  return env.LOCAL_REVIEW_HOME?.trim() || join(homedir(), '.local-review');
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The folders a session works in: where it started, and where it is now. */
export const sessionDirs = (s: SessionRecord): string[] =>
  s.workingDir && s.workingDir !== s.cwd ? [s.cwd, s.workingDir] : [s.cwd];

/** Default liveness check: the process still exists. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** File-based registry of the running agent sessions of this machine (`<home>/sessions/`). */
export class SessionRegistry {
  readonly dir: string;

  constructor(
    home: string = localReviewHome(),
    private readonly isAlive: (pid: number) => boolean = isProcessAlive,
  ) {
    this.dir = join(home, 'sessions');
  }

  private file(id: string, kind: 'json' | 'touched' | 'inbox'): string {
    // Ids come from agents: never let one escape the registry folder.
    if (!SESSION_ID.test(id)) throw new Error(`Invalid session id: ${id}`);
    return join(this.dir, kind === 'json' ? `${id}.json` : `${id}.${kind}.jsonl`);
  }

  /** Registers (or refreshes) a session. Written atomically: readers never see half a file. */
  async register(record: SessionRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const target = this.file(record.id, 'json');
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(record, null, 2) + '\n');
    await rename(tmp, target);
  }

  /**
   * The session now works in `dir`, on `branch` (a function to compute it only when the session did
   * move). No-op for an unknown session, or one already there.
   */
  async moveTo(
    id: string,
    dir: string,
    branch: string | null | ((dir: string) => Promise<string | null>),
  ): Promise<void> {
    const record = await readRecord(this.file(id, 'json'));
    if (!record || (record.workingDir ?? record.cwd) === dir) return;
    await this.register({
      ...record,
      workingDir: dir,
      branch: typeof branch === 'function' ? await branch(dir) : branch,
    });
  }

  /** Everything the registry keeps about a session goes with it. */
  async unregister(id: string): Promise<void> {
    this.file(id, 'json'); // validates the id
    let names: string[] = [];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    await Promise.all(names.filter((n) => n.startsWith(`${id}.`)).map((n) => rm(join(this.dir, n), { force: true })));
  }

  /** A small note an adapter keeps about a session between two hooks (removed with the session). */
  async setNote(id: string, key: string, value: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.note(id, key), value);
  }

  /** Reads and removes a note; `undefined` when there is none. */
  async takeNote(id: string, key: string): Promise<string | undefined> {
    const file = this.note(id, key);
    try {
      const value = await readFile(file, 'utf8');
      await rm(file, { force: true });
      return value;
    } catch {
      return undefined;
    }
  }

  private note(id: string, key: string): string {
    if (!SESSION_ID.test(key)) throw new Error(`Invalid note key: ${key}`);
    this.file(id, 'json'); // validates the id
    return join(this.dir, `${id}.note-${key}`);
  }

  /** Records that a session wrote a file. Appended, so concurrent hooks never lose an entry. */
  async touch(id: string, absolutePath: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await appendFile(
      this.file(id, 'touched'),
      JSON.stringify({ path: absolutePath, at: new Date().toISOString() }) + '\n',
    );
  }

  /** Hands threads to a session. Appended to its inbox, which its agent's adapter watches. */
  async deliver(id: string, delivery: Delivery): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.file(id, 'inbox'), JSON.stringify(delivery) + '\n');
  }

  /**
   * Deliveries appended to a session's inbox since `cursor` (none: from the start), and the cursor
   * to read from next time. A line still being written is left for next time.
   */
  async readInbox(id: string, cursor?: InboxCursor): Promise<{ deliveries: Delivery[]; cursor: InboxCursor }> {
    let handle;
    try {
      handle = await open(this.file(id, 'inbox'), 'r');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { deliveries: [], cursor: { file: 0, offset: 0 } };
      throw err;
    }
    try {
      const { ino, size } = await handle.stat();
      // Another file than last time: the inbox was removed and started again, read it all.
      const from = cursor && cursor.file === ino && cursor.offset <= size ? cursor.offset : 0;
      const buffer = Buffer.alloc(size - from);
      await handle.read(buffer, 0, buffer.length, from);
      const end = buffer.lastIndexOf(0x0a) + 1;
      const deliveries: Delivery[] = [];
      for (const line of buffer.subarray(0, end).toString('utf8').split('\n')) {
        const delivery = parseDelivery(line);
        if (delivery) deliveries.push(delivery);
      }
      return { deliveries, cursor: { file: ino, offset: from + end } };
    } finally {
      await handle.close();
    }
  }

  /** Running sessions. Sessions whose process is gone (e.g. after a crash) are removed on the way. */
  async list(): Promise<Session[]> {
    let names: string[];
    try {
      names = (await readdir(this.dir)).filter((n) => n.endsWith('.json'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const sessions: Session[] = [];
    for (const name of names.sort()) {
      const record = await readRecord(join(this.dir, name));
      if (!record || !SESSION_ID.test(record.id)) continue;
      if (record.pid !== null && !this.isAlive(record.pid)) {
        await this.unregister(record.id).catch(() => undefined);
        continue;
      }
      const writtenAt = await this.readTouched(record.id);
      sessions.push({ ...record, touched: Object.keys(writtenAt), writtenAt });
    }
    return sessions;
  }

  /** The files a session wrote, each once with its last write, ordered by it (most recent last). */
  private async readTouched(id: string): Promise<Record<string, string>> {
    let text: string;
    try {
      text = await readFile(this.file(id, 'touched'), 'utf8');
    } catch {
      return {};
    }
    const order = new Map<string, string>();
    for (const line of text.split('\n')) {
      try {
        const { path, at } = JSON.parse(line) as { path?: unknown; at?: unknown };
        if (typeof path !== 'string') continue;
        order.delete(path);
        order.set(path, typeof at === 'string' ? at : '');
      } catch {
        // an interrupted or corrupt line: skip it
      }
    }
    return Object.fromEntries(order);
  }
}

/**
 * Deliveries waiting for a session (`<home>/queue/`): published while no agent session worked on
 * their folder. They go out when one starts there.
 */
export class DeliveryQueue {
  readonly dir: string;

  constructor(home: string = localReviewHome()) {
    this.dir = join(home, 'queue');
  }

  private file(root: string): string {
    return join(this.dir, `${createHash('sha256').update(root).digest('hex').slice(0, 24)}.jsonl`);
  }

  async add(delivery: Delivery): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.file(delivery.root), JSON.stringify(delivery) + '\n');
  }

  /** What waits for the folder `root`, without taking it. */
  async peek(root: string): Promise<Delivery[]> {
    return readDeliveries(this.file(root));
  }

  /**
   * Takes what waits for `root`, emptying its queue. Atomic: of several VS Code windows showing the
   * same folder, only one gets each delivery.
   */
  async take(root: string): Promise<Delivery[]> {
    const file = this.file(root);
    const taken = `${file}.${process.pid}.${Date.now()}.taken`;
    try {
      await rename(file, taken);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const deliveries = await readDeliveries(taken);
    await rm(taken, { force: true });
    return deliveries;
  }
}

async function readDeliveries(file: string): Promise<Delivery[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .map(parseDelivery)
    .filter((d): d is Delivery => d !== null);
}

async function readRecord(file: string): Promise<SessionRecord | null> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as Partial<SessionRecord>;
    if (typeof raw.id !== 'string' || typeof raw.agent !== 'string' || typeof raw.cwd !== 'string') return null;
    return {
      id: raw.id,
      agent: raw.agent,
      cwd: raw.cwd,
      workingDir: typeof raw.workingDir === 'string' ? raw.workingDir : null,
      branch: typeof raw.branch === 'string' ? raw.branch : null,
      pid: typeof raw.pid === 'number' ? raw.pid : null,
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
      push: typeof raw.push === 'boolean' ? raw.push : null,
      pushCommand: typeof raw.pushCommand === 'string' ? raw.pushCommand : null,
    };
  } catch {
    return null;
  }
}

function parseDelivery(line: string): Delivery | null {
  if (line.trim() === '') return null;
  try {
    const raw = JSON.parse(line) as Partial<Delivery>;
    if (typeof raw.id !== 'string' || typeof raw.root !== 'string' || !Array.isArray(raw.threadIds)) return null;
    const kind = raw.kind === 'review' || raw.kind === 'reply' ? raw.kind : 'comment';
    return {
      id: raw.id,
      at: typeof raw.at === 'string' ? raw.at : '',
      root: raw.root,
      kind,
      threadIds: raw.threadIds.filter((t): t is string => typeof t === 'string'),
      ...(typeof raw.reviewId === 'string' ? { reviewId: raw.reviewId } : {}),
    };
  } catch {
    return null; // corrupt line: skip it
  }
}

import { appendFile, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store';
import { topicKey, type Topic } from './topics';

/**
 * A running agent session known to silykat. Written by the agent's adapter (e.g. the Claude
 * Code plugin's hooks), read by the VS Code extension to know where to send the comments.
 */
export interface SessionRecord {
  /** The agent's own session id. */
  id: string;
  /** Display name of the agent, e.g. "Claude". */
  agent: string;
  /** Folder the session was started in. */
  cwd: string;
  /** Git branch of that folder, if any. */
  branch: string | null;
  /** Process to watch: when it is gone, so is the session. `null` when unknown. */
  pid: number | null;
  startedAt: string;
  /**
   * Whether deliveries reach the agent on their own, even while it waits for the user (for Claude
   * Code: the session was launched with the silykat channel). `null` when unknown.
   */
  push?: boolean | null;
  /** When `push` is not true: the command that launches the agent with push on, shown to the user. */
  pushCommand?: string | null;
}

/** Where the last read of an inbox stopped. */
export interface InboxCursor {
  file: number;
  /**
   * The start of the file's first line: with the inode, it tells the same file from a new one (on
   * Linux, a file removed and created again often gets the same inode).
   */
  head: string;
  offset: number;
}

/** Bytes of the first line kept in a cursor: enough to tell two deliveries apart (their ids). */
const CURSOR_HEAD_BYTES = 256;

/** "The user published these threads": what the agent of a session is asked to process. */
export interface Delivery {
  id: string;
  at: string;
  /** Folder holding the `.silykat/` store of the threads. */
  root: string;
  /**
   * A new thread, a reply outside a review, a submitted review, or a change to published comments:
   * one edited, or deleted (with its whole thread, when it was the last one).
   */
  kind: 'comment' | 'reply' | 'review' | 'edit' | 'delete';
  threadIds: string[];
  reviewId?: string;
  /** Every session this publication went to (the same threads may go to several). */
  recipients?: string[];
}

/** A command an agent is running: the message of its conversation that runs it. */
export interface AgentCall {
  /** The agent's id of that message (for Claude Code: the tool call's id). */
  message: string;
  command: string;
  at: string;
}

const CALL_NOTE = 'call-';

/** A call older than this is not the one running `slk` now (its end was missed, e.g. interrupted). */
const CALL_MAX_AGE_MS = 15 * 60_000;

/**
 * The call that runs a command about `threadId`: the latest recent one whose command names the
 * thread, else the only recent call. `undefined` when it cannot be told.
 */
export function callFor(calls: readonly AgentCall[], threadId: string, now = Date.now()): AgentCall | undefined {
  const recent = calls.filter((c) => now - Date.parse(c.at) <= CALL_MAX_AGE_MS);
  const naming = recent.filter((c) => c.command.includes(threadId));
  const pick = naming.length > 0 ? naming : recent.length === 1 ? recent : [];
  return pick.reduce<AgentCall | undefined>((a, c) => (a === undefined || c.at > a.at ? c : a), undefined);
}

/** Why a session is subscribed to a topic: for debugging, and to explain it. */
export type SubscriptionReason = 'launch' | 'modified' | 'user';

export interface Subscription {
  topic: Topic;
  reason: SubscriptionReason;
  at: string;
}

/** A running session, with what it is subscribed to. */
export interface Session extends SessionRecord {
  subscriptions: Subscription[];
}

/**
 * Root of the files outside any open folder: comments on them go to the machine store, and their
 * anchors hold their full path. Agents are sent `--root /` for them.
 */
export const LOOSE_ROOT = '/';

/** The machine store of the files outside any open folder (`<home>/files/`). */
export function looseStore(env: Record<string, string | undefined> = process.env): Store {
  return new Store(LOOSE_ROOT, join(silykatHome(env), 'files'));
}

/** The store of a root: `<root>/.silykat/`, or the machine store for `LOOSE_ROOT`. */
export function storeAt(root: string, env: Record<string, string | undefined> = process.env): Store {
  return root === LOOSE_ROOT ? looseStore(env) : new Store(root);
}

/** silykat's per-machine folder: `$SILYKAT_HOME`, or `~/.silykat`. */
export function silykatHome(env: Record<string, string | undefined> = process.env): string {
  return env.SILYKAT_HOME?.trim() || join(homedir(), '.silykat');
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

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
    home: string = silykatHome(),
    private readonly isAlive: (pid: number) => boolean = isProcessAlive,
  ) {
    this.dir = join(home, 'sessions');
  }

  private file(id: string, kind: 'json' | 'subscriptions' | 'inbox'): string {
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

  /**
   * Notes a command an agent starts (e.g. `slk review reply …`), written by its adapter before it runs: `slk`
   * then knows which message of the agent's conversation runs it. Removed by `endCall`, or with the
   * session.
   */
  async startCall(id: string, call: AgentCall): Promise<void> {
    await this.setNote(id, `${CALL_NOTE}${call.message}`, JSON.stringify(call));
  }

  async endCall(id: string, message: string): Promise<void> {
    await this.takeNote(id, `${CALL_NOTE}${message}`);
  }

  /** The commands of a session that are running (as noted by its adapter). */
  async calls(id: string): Promise<AgentCall[]> {
    this.file(id, 'json'); // validates the id
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const prefix = `${id}.note-${CALL_NOTE}`;
    const calls = await Promise.all(
      names
        .filter((n) => n.startsWith(prefix))
        .map(async (n) => {
          try {
            const raw = JSON.parse(await readFile(join(this.dir, n), 'utf8')) as Partial<AgentCall>;
            return typeof raw.message === 'string' && typeof raw.command === 'string' && typeof raw.at === 'string'
              ? { message: raw.message, command: raw.command, at: raw.at }
              : null;
          } catch {
            return null; // being written, or removed meanwhile
          }
        }),
    );
    return calls.filter((c): c is AgentCall => c !== null);
  }

  private note(id: string, key: string): string {
    if (!SESSION_ID.test(key)) throw new Error(`Invalid note key: ${key}`);
    this.file(id, 'json'); // validates the id
    return join(this.dir, `${id}.note-${key}`);
  }

  /**
   * Subscribes a session to a topic. Resolves to `true` when it was not subscribed yet (e.g. to tell
   * the agent). Appended, so concurrent hooks never lose an entry.
   */
  async subscribe(id: string, topic: Topic, reason: SubscriptionReason): Promise<boolean> {
    const already = (await this.subscriptions(id)).some((s) => topicKey(s.topic) === topicKey(topic));
    if (already) return false;
    await this.appendSubscription(id, { op: 'add', topic, reason, at: new Date().toISOString() });
    return true;
  }

  /** Unsubscribes a session from a topic, or from everything. Resolves to what it was subscribed to. */
  async unsubscribe(id: string, topic: Topic | 'all'): Promise<Subscription[]> {
    const current = await this.subscriptions(id);
    const gone = topic === 'all' ? current : current.filter((s) => topicKey(s.topic) === topicKey(topic));
    for (const s of gone)
      await this.appendSubscription(id, { op: 'remove', topic: s.topic, at: new Date().toISOString() });
    return gone;
  }

  /** What a session is subscribed to, oldest first. */
  async subscriptions(id: string): Promise<Subscription[]> {
    let text: string;
    try {
      text = await readFile(this.file(id, 'subscriptions'), 'utf8');
    } catch {
      return [];
    }
    const current = new Map<string, Subscription>();
    for (const line of text.split('\n')) {
      try {
        const e = JSON.parse(line) as { op?: unknown; topic?: Topic; reason?: SubscriptionReason; at?: string };
        if (!e.topic || (e.topic.kind !== 'branch' && e.topic.kind !== 'path')) continue;
        const key = topicKey(e.topic);
        if (e.op === 'remove') current.delete(key);
        else if (e.op === 'add' && !current.has(key))
          current.set(key, { topic: e.topic, reason: e.reason ?? 'user', at: e.at ?? '' });
      } catch {
        // an interrupted or corrupt line: skip it
      }
    }
    return [...current.values()];
  }

  private async appendSubscription(id: string, event: object): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.file(id, 'subscriptions'), JSON.stringify(event) + '\n');
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
      if ((err as NodeJS.ErrnoException).code === 'ENOENT')
        return { deliveries: [], cursor: { file: 0, head: '', offset: 0 } };
      throw err;
    }
    try {
      const { ino, size } = await handle.stat();
      const start = Buffer.alloc(Math.min(size, CURSOR_HEAD_BYTES));
      await handle.read(start, 0, start.length, 0);
      const newline = start.indexOf(0x0a);
      const head = start.subarray(0, newline < 0 ? start.length : newline).toString('utf8');
      // Another file than last time: the inbox was removed and started again, read it all.
      const same = cursor && cursor.file === ino && cursor.head === head && cursor.offset <= size;
      const from = same ? cursor.offset : 0;
      const buffer = Buffer.alloc(size - from);
      await handle.read(buffer, 0, buffer.length, from);
      const end = buffer.lastIndexOf(0x0a) + 1;
      const deliveries: Delivery[] = [];
      for (const line of buffer.subarray(0, end).toString('utf8').split('\n')) {
        const delivery = parseDelivery(line);
        if (delivery) deliveries.push(delivery);
      }
      return { deliveries, cursor: { file: ino, head, offset: from + end } };
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
      sessions.push({ ...record, subscriptions: await this.subscriptions(record.id) });
    }
    return sessions;
  }
}

async function readRecord(file: string): Promise<SessionRecord | null> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as Partial<SessionRecord>;
    if (typeof raw.id !== 'string' || typeof raw.agent !== 'string' || typeof raw.cwd !== 'string') return null;
    return {
      id: raw.id,
      agent: raw.agent,
      cwd: raw.cwd,
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
    const kinds: Delivery['kind'][] = ['comment', 'reply', 'review', 'edit', 'delete'];
    const kind = kinds.includes(raw.kind as Delivery['kind']) ? (raw.kind as Delivery['kind']) : 'comment';
    return {
      id: raw.id,
      at: typeof raw.at === 'string' ? raw.at : '',
      root: raw.root,
      kind,
      threadIds: raw.threadIds.filter((t): t is string => typeof t === 'string'),
      ...(typeof raw.reviewId === 'string' ? { reviewId: raw.reviewId } : {}),
      ...(Array.isArray(raw.recipients)
        ? { recipients: raw.recipients.filter((r): r is string => typeof r === 'string') }
        : {}),
    };
  } catch {
    return null; // corrupt line: skip it
  }
}

/** The parent processes of `pid`, closest first (via `ps`; empty where it is not available). */
export async function processAncestors(pid: number = process.ppid, max = 12): Promise<number[]> {
  const { execFile } = await import('node:child_process');
  const parentOf = (p: number) =>
    new Promise<number | null>((done) =>
      execFile('ps', ['-o', 'ppid=', '-p', String(p)], { timeout: 2000 }, (err, out) => {
        const n = Number(out.trim());
        done(err || !Number.isInteger(n) ? null : n);
      }),
    );
  const chain = [pid];
  for (let p: number | null = pid; chain.length < max;) {
    p = await parentOf(p);
    if (p === null || p <= 1) break;
    chain.push(p);
  }
  return chain;
}

/**
 * The session a command runs in: the registered session whose process is one of its ancestors
 * (an agent runs `slk` through its shell).
 */
export function sessionOfProcess(sessions: readonly Session[], ancestors: readonly number[]): Session | undefined {
  for (const pid of ancestors) {
    const found = sessions.filter((s) => s.pid === pid);
    if (found.length > 0) return found.reduce((a, s) => (s.startedAt > a.startedAt ? s : a));
  }
  return undefined;
}

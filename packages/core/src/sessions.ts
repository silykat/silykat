import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
  /** Folder the session works in. */
  cwd: string;
  /** Git branch of that folder when the session registered, if any. */
  branch: string | null;
  /** Process to watch: when it is gone, so is the session. `null` when unknown. */
  pid: number | null;
  startedAt: string;
}

/** A session, with the files it wrote (absolute paths, most recent last). */
export interface Session extends SessionRecord {
  touched: string[];
}

/** Local Review's per-machine folder: `$LOCAL_REVIEW_HOME`, or `~/.local-review`. */
export function localReviewHome(env: Record<string, string | undefined> = process.env): string {
  return env.LOCAL_REVIEW_HOME?.trim() || join(homedir(), '.local-review');
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
    home: string = localReviewHome(),
    private readonly isAlive: (pid: number) => boolean = isProcessAlive,
  ) {
    this.dir = join(home, 'sessions');
  }

  private file(id: string, ext: 'json' | 'touched'): string {
    // Ids come from agents: never let one escape the registry folder.
    if (!SESSION_ID.test(id)) throw new Error(`Invalid session id: ${id}`);
    return join(this.dir, ext === 'json' ? `${id}.json` : `${id}.touched.jsonl`);
  }

  /** Registers (or refreshes) a session. Written atomically: readers never see half a file. */
  async register(record: SessionRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const target = this.file(record.id, 'json');
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(record, null, 2) + '\n');
    await rename(tmp, target);
  }

  async unregister(id: string): Promise<void> {
    await rm(this.file(id, 'json'), { force: true });
    await rm(this.file(id, 'touched'), { force: true });
  }

  /** Records that a session wrote a file. Appended, so concurrent hooks never lose an entry. */
  async touch(id: string, absolutePath: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await appendFile(
      this.file(id, 'touched'),
      JSON.stringify({ path: absolutePath, at: new Date().toISOString() }) + '\n',
    );
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
      sessions.push({ ...record, touched: await this.readTouched(record.id) });
    }
    return sessions;
  }

  private async readTouched(id: string): Promise<string[]> {
    let text: string;
    try {
      text = await readFile(this.file(id, 'touched'), 'utf8');
    } catch {
      return [];
    }
    const paths: string[] = [];
    for (const line of text.split('\n')) {
      try {
        const { path } = JSON.parse(line) as { path?: unknown };
        if (typeof path === 'string') paths.push(path);
      } catch {
        // an interrupted or corrupt line: skip it
      }
    }
    // Each file once, ordered by its most recent write (most recent last).
    const order = new Map<string, true>();
    for (const p of paths) {
      order.delete(p);
      order.set(p, true);
    }
    return [...order.keys()];
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
    };
  } catch {
    return null;
  }
}

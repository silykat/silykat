import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { CommentState, ThreadState } from './types';
import { localReviewHome } from './sessions';
import { STORE_DIR } from './types';

/** What an agent sees of a thread: published comments only (drafts belong to the user until submitted). */
export interface AgentThreadView {
  thread: ThreadState;
  comments: CommentState[];
  /** The next move is the agent's: the user spoke last in a thread that is not resolved. */
  needsAgent: boolean;
  /** The agent asked or answered, and waits for the user. */
  waitsForUser: boolean;
}

export function agentView(thread: ThreadState): AgentThreadView | null {
  if (thread.deleted) return null;
  const comments = thread.comments.filter((c) => !c.isDraft);
  if (comments.length === 0) return null; // only drafts: invisible to agents
  const last = comments[comments.length - 1]!;
  const open = thread.status !== 'resolved';
  return {
    thread,
    comments,
    needsAgent: open && last.author === 'user',
    waitsForUser: open && last.author === 'agent',
  };
}

/**
 * Whether `dir/.local-review/` is a store of comments. It must look like one (a schema version or
 * threads), and must not be Local Review's per-machine folder: that one is also `~/.local-review/`
 * by default, but only holds the registry of agent sessions.
 */
export function isStoreRoot(dir: string, env: Record<string, string | undefined> = process.env): boolean {
  const store = join(dir, STORE_DIR);
  if (!existsSync(join(store, 'schema-version')) && !existsSync(join(store, 'threads'))) return false;
  return realpath(store) !== realpath(localReviewHome(env));
}

/** The directory holding a store, looking in `fromDir` and its parents. */
export function findStoreRoot(fromDir: string, env: Record<string, string | undefined> = process.env): string | null {
  let dir = resolve(fromDir);
  for (;;) {
    if (isStoreRoot(dir, env)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const SKIPPED = new Set(['node_modules', '.git', 'dist', 'out', '.vscode-test', STORE_DIR]);

/** Stores below a folder (a few levels deep), e.g. the repositories of a parent folder. */
export function findStoresBelow(
  dir: string,
  maxDepth = 3,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const found: string[] = [];
  const walk = (current: string, depth: number) => {
    if (depth > maxDepth || found.length >= 20) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIPPED.has(entry.name)) continue;
      const child = join(current, entry.name);
      if (isStoreRoot(child, env)) found.push(child);
      walk(child, depth + 1);
    }
  };
  walk(resolve(dir), 1);
  return found.sort();
}

function realpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

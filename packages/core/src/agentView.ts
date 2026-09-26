import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { CommentState, ThreadState } from './types';
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

/** The directory holding `.local-review/`, looking in `fromDir` and its parents. */
export function findStoreRoot(fromDir: string): string | null {
  let dir = resolve(fromDir);
  for (;;) {
    if (existsSync(join(dir, STORE_DIR))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export const SCHEMA_VERSION = 1;
export const STORE_DIR = '.local-review';

/** Who wrote an event. `agent` is any AI coding agent (Claude, Codex…), named by the event's `agent` field. */
export type Author = 'user' | 'agent';
export type ThreadStatus = 'open' | 'needs-info' | 'addressed' | 'resolved';

/**
 * Why a thread was deleted: the user removed it (`user`), or its git branch was deleted
 * (`branch-gone`). Journals written before reasons were recorded have none.
 */
export type DeleteReason = 'user' | 'branch-gone';
export const DELETE_REASONS: readonly DeleteReason[] = ['user', 'branch-gone'];

/**
 * The agent's conversation a comment was written in: its session (the agent's own id), and when the
 * agent's integration knows it, the message that wrote the comment (for Claude Code: the id of the
 * tool call that ran `lr reply`). Lets a retro read the conversation back while the agent keeps it.
 */
export interface AgentSessionRef {
  id: string;
  message?: string;
}

/** A valid session reference read from a journal (written by any version or tool), else `undefined`. */
export function sessionRefOf(raw: unknown): AgentSessionRef | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { id, message } = raw as { id?: unknown; message?: unknown };
  if (typeof id !== 'string' || id.trim() === '') return undefined;
  return typeof message === 'string' && message.trim() !== '' ? { id, message } : { id };
}

/** 1-based, inclusive on both ends. */
export interface LineRange {
  startLine: number;
  endLine: number;
}

export interface AnchorSide {
  source: 'worktree' | 'git';
  ref: string | null;
  sha: string | null;
  /**
   * File of this side of the diff, relative to the store root (absolute when outside it).
   * Set on diff sides, which may be another file than the thread's (e.g. "Compare Selected");
   * missing on older anchors, where both sides are the thread's own file.
   */
  path?: string;
}

export interface DiffInfo {
  side: 'base' | 'head';
  base: AnchorSide;
  head: AnchorSide;
}

export interface Anchor {
  /** Relative to the store root, `/`-separated. */
  path: string;
  source: 'worktree' | 'git';
  ref: string | null;
  sha: string | null;
  diff?: DiffInfo;
  /** `null` means a file-level comment. */
  range: LineRange | null;
  snippet: string;
  contextBefore: string[];
  contextAfter: string[];
}

export interface CommentState {
  id: string;
  author: Author;
  /** Display name of the agent, for agent comments. */
  agentName?: string;
  body: string;
  createdAt: string;
  editedAt?: string;
  reviewId: string | null;
  isDraft: boolean;
}

/** A git branch a thread or a review belongs to: that branch of that repository. */
export interface BranchRef {
  /** The repository: its common git folder, shared by all its worktrees. */
  repo: string;
  branch: string;
  /** Where the branch was checked out when this was written (it may move). */
  worktree?: string;
}

/** Identity of a branch (`''` for none): two refs with the same key are the same branch. */
export const branchKey = (b: BranchRef | null | undefined): string => (b ? `${b.repo}#${b.branch}` : '');

/**
 * What a review is about: a branch, or off any branch (outside git, or files ignored by git) a
 * folder: the direct parent of the files, as an anchor path (`.` for the root itself). Reviews
 * started off any branch before folders had their own have neither: they cover no file.
 */
export interface ReviewScope {
  branch: BranchRef | null;
  /** Off any branch only: the folder reviewed. */
  path?: string | null;
}

/** Identity of a review scope: two reviews with the same key are about the same thing. */
export const reviewScopeKey = (s: ReviewScope): string =>
  s.branch ? branchKey(s.branch) : s.path ? `path:${s.path}` : '';

export interface ThreadState {
  id: string;
  anchor: Anchor;
  /** The branch of its file when it was created (followed when renamed); `null` outside git. */
  branch: BranchRef | null;
  status: ThreadStatus;
  comments: CommentState[];
  createdAt: string;
  deleted: boolean;
  /** Written by a newer schema version: never write to it. */
  readOnly: boolean;
  lastAuthor: Author | null;
  /** Name of the agent that commented last in this thread, if any. */
  lastAgentName: string | null;
  hasPublished: boolean;
  onlyDrafts: boolean;
}

export interface ReviewState {
  id: string;
  state: 'active' | 'submitted' | 'discarded';
  /** The branch it reviews (one review per branch); `null` outside git. */
  branch: BranchRef | null;
  /** Off any branch: the folder it reviews (one review per folder), as an anchor path. */
  path: string | null;
  summary?: string;
  startedAt: string;
  submittedAt?: string;
}

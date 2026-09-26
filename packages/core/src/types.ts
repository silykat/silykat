export const SCHEMA_VERSION = 1;
export const STORE_DIR = '.local-review';

export type Author = 'user' | 'claude';
export type ThreadStatus = 'open' | 'needs-info' | 'addressed' | 'resolved';

/** 1-based, inclusive on both ends. */
export interface LineRange {
  startLine: number;
  endLine: number;
}

export interface AnchorSide {
  source: 'worktree' | 'git';
  ref: string | null;
  sha: string | null;
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
  body: string;
  createdAt: string;
  editedAt?: string;
  reviewId: string | null;
  isDraft: boolean;
}

export interface ThreadState {
  id: string;
  anchor: Anchor;
  status: ThreadStatus;
  comments: CommentState[];
  createdAt: string;
  deleted: boolean;
  /** Written by a newer schema version: never write to it. */
  readOnly: boolean;
  lastAuthor: Author | null;
  hasPublished: boolean;
  onlyDrafts: boolean;
}

export interface ReviewState {
  id: string;
  state: 'active' | 'submitted' | 'discarded';
  summary?: string;
  startedAt: string;
  submittedAt?: string;
}

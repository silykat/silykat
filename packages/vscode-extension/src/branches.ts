import { dirname } from 'node:path';
import { branchKey, gitWorktreeOf, worktreeTopOf, type BranchRef } from '@local-review/core';

/**
 * Which branch is checked out where: the git worktree of each folder seen (cached, it does not
 * change), and the branch of each worktree (refreshed on demand, e.g. at every poll).
 */
export class Branches {
  /** Folder → the top of its git worktree (`null`: outside git). */
  private readonly tops = new Map<string, string | null>();
  /** Worktree top → the branch checked out there (`null`: none, e.g. detached HEAD). */
  private readonly heads = new Map<string, BranchRef | null>();

  /** Learns where a file is (its worktree, and that worktree's branch), once. */
  async learn(file: string): Promise<void> {
    const dir = dirname(file);
    if (!this.tops.has(dir)) this.tops.set(dir, await worktreeTopOf(dir));
    const top = this.tops.get(dir);
    if (top && !this.heads.has(top)) this.heads.set(top, await readHead(top));
  }

  /** The worktree of a file, if known. */
  worktreeOf(file: string): string | null | undefined {
    return this.tops.get(dirname(file));
  }

  /**
   * The branch checked out where a file is: `null` outside git or without a branch, `undefined`
   * while unknown (call `learn` first).
   */
  checkedOut(file: string): BranchRef | null | undefined {
    const top = this.tops.get(dirname(file));
    if (top === undefined) return undefined;
    return top === null ? null : this.heads.get(top);
  }

  /** Git worktrees seen so far. */
  worktrees(): string[] {
    return [...this.heads.keys()];
  }

  /** Re-reads the branch of every known worktree. Resolves to the worktrees whose branch changed. */
  async refresh(): Promise<string[]> {
    const changed: string[] = [];
    for (const top of this.heads.keys()) {
      const now = await readHead(top);
      if (branchKey(now) !== branchKey(this.heads.get(top))) {
        this.heads.set(top, now);
        changed.push(top);
      }
    }
    return changed;
  }

  /** Reads the branch of one worktree now, bypassing the cache (e.g. right before writing). */
  async readNow(file: string): Promise<BranchRef | null> {
    const wt = await gitWorktreeOf(dirname(file));
    return wt ? { repo: wt.repo, branch: wt.branch, worktree: wt.worktree } : null;
  }

  clear(): void {
    this.tops.clear();
    this.heads.clear();
  }
}

async function readHead(top: string): Promise<BranchRef | null> {
  const wt = await gitWorktreeOf(top);
  return wt ? { repo: wt.repo, branch: wt.branch, worktree: wt.worktree } : null;
}

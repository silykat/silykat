import type { Anchor } from '@local-review/core';

// Pure helpers for the `git:` URIs of VS Code's built-in git extension (no `vscode` import).
// Their query is JSON: {"path": "<absolute fsPath>", "ref": "<ref>"}. The URI path itself may be
// altered (e.g. a ".git" suffix), so the file is always read from `query.path`.

export interface GitRef {
  fsPath: string;
  ref: string;
}

/** Parses a `git:` URI query. `null` for anything we do not support (submodules, merge stages…). */
export function parseGitQuery(query: string): GitRef | null {
  let raw: unknown;
  try {
    raw = JSON.parse(query);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const { path, ref, submoduleOf } = raw as Record<string, unknown>;
  if (typeof path !== 'string' || typeof ref !== 'string' || submoduleOf !== undefined) return null;
  if (/^:[123]$/.test(ref)) return null; // merge conflict stages
  return { fsPath: path, ref };
}

/** `~` and `""` both mean the git index (staged content). */
export function isIndexRef(ref: string): boolean {
  return ref === '~' || ref === '';
}

/** Anchor ref stored for a git version: the index is always recorded as `~`. */
export function anchorRef(ref: string): string {
  return isIndexRef(ref) ? '~' : ref;
}

/** Short name of the version a git anchor is about, shown in its label; `undefined` for the working tree. */
export function versionTag(anchor: Pick<Anchor, 'source' | 'ref' | 'sha'>): string | undefined {
  if (anchor.source !== 'git') return undefined;
  if (anchor.ref === null || isIndexRef(anchor.ref)) return 'Index';
  const short = anchor.sha?.slice(0, 7);
  if (anchor.ref === 'HEAD') return short ? `HEAD ${short}` : 'HEAD';
  return short ?? anchor.ref;
}

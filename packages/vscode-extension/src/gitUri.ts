import { isIndexRef } from '@local-review/core';

export { isIndexRef, versionTag } from '@local-review/core';

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

/** Anchor ref stored for a git version: the index is always recorded as `~`. */
export function anchorRef(ref: string): string {
  return isIndexRef(ref) ? '~' : ref;
}

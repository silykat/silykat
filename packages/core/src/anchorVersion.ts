import type { Anchor } from './types';

/** `~` and `""` both mean the git index (staged content), as in VS Code's git URIs. */
export function isIndexRef(ref: string): boolean {
  return ref === '~' || ref === '';
}

/** Short name of the version a git anchor is about ("Index", "HEAD a92bf1e"…); `undefined` for the working tree. */
export function versionTag(anchor: Pick<Anchor, 'source' | 'ref' | 'sha'>): string | undefined {
  if (anchor.source !== 'git') return undefined;
  if (anchor.ref === null || isIndexRef(anchor.ref)) return 'Index';
  const short = anchor.sha?.slice(0, 7);
  if (anchor.ref === 'HEAD') return short ? `HEAD ${short}` : 'HEAD';
  return short ?? anchor.ref;
}

import { describe, expect, it } from 'vitest';
import { anchorRef, isIndexRef, parseGitQuery, versionTag } from '../../src/gitUri';

describe('parseGitQuery', () => {
  it('reads the file and the ref from the query', () => {
    expect(parseGitQuery('{"path":"/repo/a.ts","ref":"~"}')).toEqual({ fsPath: '/repo/a.ts', ref: '~' });
    expect(parseGitQuery('{"path":"/repo/a.ts","ref":"HEAD"}')).toEqual({ fsPath: '/repo/a.ts', ref: 'HEAD' });
  });

  it('rejects what is not supported', () => {
    expect(parseGitQuery('not json')).toBeNull();
    expect(parseGitQuery('{"path":"/repo/a.ts"}')).toBeNull();
    expect(parseGitQuery('{"path":"/repo/a.ts","ref":"HEAD","submoduleOf":"/repo"}')).toBeNull();
    expect(parseGitQuery('{"path":"/repo/a.ts","ref":":2"}')).toBeNull();
  });
});

describe('index refs', () => {
  it('treats "~" and "" as the index, stored as "~"', () => {
    expect(isIndexRef('~')).toBe(true);
    expect(isIndexRef('')).toBe(true);
    expect(isIndexRef('HEAD')).toBe(false);
    expect(anchorRef('')).toBe('~');
    expect(anchorRef('HEAD')).toBe('HEAD');
  });
});

describe('versionTag', () => {
  it('names the version of git anchors only', () => {
    expect(versionTag({ source: 'worktree', ref: null, sha: null })).toBeUndefined();
    expect(versionTag({ source: 'git', ref: '~', sha: null })).toBe('Index');
    expect(versionTag({ source: 'git', ref: 'HEAD', sha: 'a92bf1ebf06d24c91791a89159ac0f0208895074' })).toBe(
      'HEAD a92bf1e',
    );
    expect(versionTag({ source: 'git', ref: 'a92bf1ebf06d', sha: 'a92bf1ebf06d24c91791a89159ac0f0208895074' })).toBe(
      'a92bf1e',
    );
  });
});

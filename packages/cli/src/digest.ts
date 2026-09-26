import { extname } from 'node:path';
import { reanchor, versionTag, type AgentThreadView, type LineRange, type ReviewState } from '@local-review/core';

/** Where a thread's code is now, as the agent should read it. */
export interface Located {
  view: AgentThreadView;
  /** Current lines of the code (1-based), `null` for file comments and outdated threads. */
  range: LineRange | null;
  /** Code to show: the current one when found, else the one recorded with the thread. */
  code: string;
  outdated: boolean;
}

/**
 * Finds the code of a thread in the current file. Working tree threads follow the file; git
 * threads are about a fixed version (index or commit), so their recorded code is shown as is.
 */
export function locate(view: AgentThreadView, fileText: string | null): Located {
  const a = view.thread.anchor;
  if (!a.range) return { view, range: null, code: '', outdated: false };
  if (a.source !== 'worktree') return { view, range: a.range, code: a.snippet, outdated: false };
  const found = fileText === null ? { kind: 'lost' as const } : reanchor(a, fileText);
  if (!found || found.kind === 'lost') return { view, range: null, code: a.snippet, outdated: true };
  const lines = fileText!.split(/\r\n|\r|\n/).slice(found.range.startLine - 1, found.range.endLine);
  return { view, range: found.range, code: lines.join('\n'), outdated: false };
}

const LANGUAGES: Record<string, string> = {
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.jsx': 'jsx',
  '.mjs': 'js',
  '.cjs': 'js',
  '.json': 'json',
  '.md': 'md',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.rb': 'ruby',
  '.sh': 'bash',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.css': 'css',
  '.html': 'html',
  '.sql': 'sql',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.cs': 'csharp',
  '.php': 'php',
  '.swift': 'swift',
};

function fence(code: string, path: string, startLine: number | null): string {
  const numbered =
    startLine === null
      ? code
      : code
          .split('\n')
          .map((l, i) => `${startLine + i} | ${l}`)
          .join('\n');
  const longest = Math.max(0, ...(numbered.match(/`+/g) ?? []).map((r) => r.length));
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${ticks}${LANGUAGES[extname(path)] ?? ''}\n${numbered}\n${ticks}`;
}

function where(l: Located): string {
  const a = l.view.thread.anchor;
  if (!a.range) return `${a.path} (whole file)`;
  if (l.outdated) return `${a.path} (outdated)`;
  const r = l.range!;
  return `${a.path}:${r.startLine}${r.endLine !== r.startLine ? `-${r.endLine}` : ''}`;
}

/** One thread, in markdown, for an agent to read. */
export function renderThread(l: Located): string {
  const { thread, comments } = l.view;
  const a = thread.anchor;
  const tag = versionTag(a);
  const lines = [`## ${thread.id} — ${where(l)}`, ''];
  const facts = [`Status: ${thread.status}`];
  if (tag)
    facts.push(`About the ${tag === 'Index' ? 'staged version (index)' : `version ${tag}`}, not the working tree`);
  if (a.diff) facts.push(`Made in a diff (${a.diff.side === 'base' ? 'old' : 'new'} side)`);
  lines.push(facts.join(' · '), '');
  if (l.outdated) lines.push('⚠️ Outdated: this code is no longer in the file. Recorded code:', '');
  if (a.range) lines.push(fence(l.code, a.path, l.outdated ? null : l.range!.startLine), '');
  for (const c of comments) {
    const who = c.author === 'user' ? 'User' : (c.agentName ?? 'Agent');
    lines.push(`**${who}** (${c.createdAt}${c.editedAt ? ', edited' : ''}):`, c.body, '');
  }
  return lines.join('\n').trimEnd();
}

/** Summaries of the submitted reviews these threads' comments belong to. */
export function renderReviews(located: readonly Located[], reviews: readonly ReviewState[]): string {
  const ids = new Set(located.flatMap((l) => l.view.comments.map((c) => c.reviewId).filter((id) => id !== null)));
  const withSummary = reviews.filter((r) => ids.has(r.id) && r.state === 'submitted' && r.summary);
  return withSummary.map((r) => `> **Review summary** (${r.submittedAt}): ${r.summary}`).join('\n');
}

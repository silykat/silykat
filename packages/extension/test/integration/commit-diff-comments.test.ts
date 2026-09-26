import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { buildAnchorContext, Store } from '@local-review/core';
import type { LocalReviewApi } from '../../src/extension';

const EXTENSION_ID = 'local.local-review';
const V1 = Array.from({ length: 8 }, (_, i) => `const v${i + 1} = ${i + 1};`);

interface GitApi {
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
  repositories: { status(): Promise<void> }[];
}

async function waitFor<T>(what: string, probe: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('Comment in the diff between two commits (Timeline)', () => {
  let api: LocalReviewApi;
  let gitApi: GitApi;
  let ws: string;
  let n = 0;

  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
      cwd: ws,
      encoding: 'utf8',
    }).trim();
  const managed = (id: string) => api.listThreads().find((t) => t.id === id)!;
  const activeDiff = () => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return input instanceof vscode.TabInputTextDiff ? input : undefined;
  };

  /** A file with two commits: returns the file and the sha of the second one. */
  async function fileWithHistory(): Promise<{ file: vscode.Uri; c2: string }> {
    const path = join(ws, `history-${++n}.ts`);
    writeFileSync(path, V1.join('\n') + '\n');
    git('add', path);
    git('commit', '-q', '-m', `v1 ${n}`, '--', path);
    const v2 = [...V1];
    v2[2] = 'const v3 = 300;';
    writeFileSync(path, v2.join('\n') + '\n');
    git('commit', '-q', '-m', `v2 ${n}`, '--', path);
    await gitApi.repositories[0]!.status();
    return { file: vscode.Uri.file(path), c2: git('rev-parse', 'HEAD') };
  }

  /** Opens a commit's diff like the Timeline does: `<sha>^` ↔ `<sha>`. */
  async function openCommitDiff(file: vscode.Uri, sha: string): Promise<vscode.TabInputTextDiff> {
    const left = gitApi.toGitUri(file, `${sha}^`);
    const right = gitApi.toGitUri(file, sha);
    await vscode.commands.executeCommand('vscode.diff', left, right, 'commit');
    return waitFor('the commit diff', () =>
      activeDiff()?.original.toString() === left.toString() ? activeDiff() : undefined,
    );
  }

  async function commentOn(uri: vscode.Uri, line: number, text: string): Promise<string> {
    await vscode.workspace.openTextDocument(uri);
    const known = new Set(api.listThreads().map((t) => t.id));
    const thread = api.controller.createCommentThread(uri, new vscode.Range(line, 0, line, 0), []);
    await vscode.commands.executeCommand('localReview.submitComment', { thread, text });
    return api.listThreads().find((t) => !known.has(t.id))!.id;
  }

  before(async () => {
    const ext = vscode.extensions.getExtension<LocalReviewApi>(EXTENSION_ID)!;
    api = await ext.activate();
    ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    const gitExt = vscode.extensions.getExtension<{ getAPI(v: 1): GitApi }>('vscode.git')!;
    gitApi = (await gitExt.activate()).getAPI(1);
    await waitFor('the git repository', () => (gitApi.repositories.length > 0 ? true : undefined), 10000);
  });

  beforeEach(async () => {
    rmSync(join(ws, '.local-review'), { recursive: true, force: true });
    await api.reload();
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('comments either side of a commit, pinned to both commits', async () => {
    const { file, c2 } = await fileWithHistory();
    const c1 = git('rev-parse', `${c2}^`);
    const diff = await openCommitDiff(file, c2);

    const before = await commentOn(diff.original, 2, 'Was 3');
    const after = await commentOn(diff.modified, 2, 'Now 300');

    assert.equal(managed(before).state.anchor.sha, c1);
    assert.equal(managed(before).state.anchor.snippet, 'const v3 = 3;');
    assert.equal(managed(after).state.anchor.sha, c2);
    assert.equal(managed(after).state.anchor.snippet, 'const v3 = 300;');
    assert.deepEqual(managed(after).state.anchor.diff, {
      side: 'head',
      base: { source: 'git', ref: `${c2}^`, sha: c1 },
      head: { source: 'git', ref: c2, sha: c2 },
    });
    assert.equal(managed(before).thread.label, `${c1.slice(0, 7)} · Waiting for Claude`);
    assert.ok(managed(before).uris.includes(diff.original.toString()));
    assert.ok(managed(after).uris.includes(diff.modified.toString()));
  });

  it('is at the same place when the same diff is reopened later', async () => {
    const { file, c2 } = await fileWithHistory();
    const diff = await openCommitDiff(file, c2);
    const id = await commentOn(diff.original, 5, 'Later');

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await api.reload();
    const again = await openCommitDiff(file, c2);
    await waitFor('the thread on the reopened diff', () =>
      managed(id).uris.includes(again.original.toString()) ? true : undefined,
    );
    assert.equal(managed(id).thread.range!.start.line, 5);
  });

  it('reopens the exact original diff after more commits', async () => {
    const { file, c2 } = await fileWithHistory();
    const c1 = git('rev-parse', `${c2}^`);
    const diff = await openCommitDiff(file, c2);
    const id = await commentOn(diff.modified, 2, 'Why 300?');

    writeFileSync(file.fsPath, V1.join('\n') + '\n');
    git('commit', '-q', '-m', 'v3', '--', file.fsPath);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    assert.ok(managed(id), 'still listed');

    assert.equal(await vscode.commands.executeCommand('localReview.openOriginalDiff', managed(id).thread), true);
    const reopened = await waitFor('the original diff', () => activeDiff());
    assert.ok(reopened.original.query.includes(c1), reopened.original.query);
    assert.ok(reopened.modified.query.includes(c2), reopened.modified.query);
  });

  it('reopens the diff of changes a thread was made in', async () => {
    const path = join(ws, `history-${++n}.ts`);
    writeFileSync(path, V1.join('\n') + '\n');
    git('add', path);
    git('commit', '-q', '-m', 'fixture', '--', path);
    writeFileSync(path, [...V1, 'const v9 = 9;'].join('\n') + '\n');
    await gitApi.repositories[0]!.status();
    const file = vscode.Uri.file(path);
    await vscode.commands.executeCommand('git.openChange', file);
    const diff = await waitFor('the diff of changes', () =>
      activeDiff()?.modified.fsPath === path ? activeDiff() : undefined,
    );
    const id = await commentOn(diff.modified, 8, 'New line');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    assert.equal(await vscode.commands.executeCommand('localReview.openOriginalDiff', managed(id).thread), true);
    const reopened = await waitFor('the diff', () => activeDiff());
    assert.equal(reopened.modified.fsPath, path);
    assert.equal(reopened.original.scheme, 'git');
  });

  it('says so when a commit of the original diff no longer exists', async () => {
    const rel = `history-gone-${++n}.ts`;
    const gone = 'deadbeef'.repeat(5);
    await new Store(ws).createThread(
      {
        path: rel,
        source: 'git',
        ref: gone,
        sha: gone,
        diff: {
          side: 'head',
          base: { source: 'git', ref: `${gone}^`, sha: gone },
          head: { source: 'git', ref: gone, sha: gone },
        },
        ...buildAnchorContext('const x = 1;\n', { startLine: 1, endLine: 1 }),
      },
      { author: 'user', body: 'On a rebased commit', reviewId: null },
    );
    await api.reload();
    const t = api.listThreads().find((x) => x.state.anchor.path === rel)!;
    assert.equal(await vscode.commands.executeCommand('localReview.openOriginalDiff', t.thread), false);
    assert.equal(activeDiff(), undefined, 'no diff opened');
  });
});

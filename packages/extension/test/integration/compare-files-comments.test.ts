import * as assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { LocalReviewApi } from '../../src/extension';

const EXTENSION_ID = 'local.local-review';

async function waitFor<T>(what: string, probe: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('Comment in a comparison of two files (Compare Selected)', () => {
  let api: LocalReviewApi;
  let ws: string;
  let n = 0;

  const managed = (id: string) => api.listThreads().find((t) => t.id === id)!;
  const activeDiff = () => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return input instanceof vscode.TabInputTextDiff ? input : undefined;
  };

  /** Two files compared with the Explorer's "Select for Compare" then "Compare with Selected". */
  async function compareTwoFiles(): Promise<{ left: vscode.Uri; right: vscode.Uri; diff: vscode.TabInputTextDiff }> {
    const k = ++n;
    const left = vscode.Uri.file(join(ws, `compare-${k}-a.ts`));
    const right = vscode.Uri.file(join(ws, `compare-${k}-b.ts`));
    writeFileSync(left.fsPath, 'const a = 1;\nconst shared = 0;\n');
    writeFileSync(right.fsPath, 'const b = 2;\nconst shared = 0;\nconst extra = 3;\n');
    await vscode.commands.executeCommand('selectForCompare', left);
    await vscode.commands.executeCommand('compareFiles', right);
    const diff = await waitFor('the comparison', () =>
      activeDiff()?.original.fsPath === left.fsPath ? activeDiff() : undefined,
    );
    return { left, right, diff };
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
  });

  beforeEach(async () => {
    rmSync(join(ws, '.local-review'), { recursive: true, force: true });
    await api.reload();
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('comments both sides, each on its own file', async () => {
    const { left, right, diff } = await compareTwoFiles();
    assert.equal(diff.modified.fsPath, right.fsPath);

    const onLeft = await commentOn(diff.original, 0, 'Why a?');
    const onRight = await commentOn(diff.modified, 2, 'Why extra?');

    const l = managed(onLeft).state.anchor;
    assert.equal(l.source, 'worktree');
    assert.equal(l.snippet, 'const a = 1;');
    assert.deepEqual(l.diff, {
      side: 'base',
      base: { source: 'worktree', ref: null, sha: null, path: `compare-${n}-a.ts` },
      head: { source: 'worktree', ref: null, sha: null, path: `compare-${n}-b.ts` },
    });
    assert.equal(managed(onRight).state.anchor.snippet, 'const extra = 3;');
    assert.equal(managed(onRight).state.anchor.diff?.side, 'head');
    assert.equal(managed(onLeft).thread.label, 'Waiting for Claude', 'no version tag: both sides are files');

    // Each thread lives on its own file, so it also shows when that file is opened alone.
    assert.equal(managed(onLeft).uris[0], left.toString());
    assert.equal(managed(onRight).uris[0], right.toString());
  });

  it('reopens the comparison of the two files', async () => {
    const { left, right, diff } = await compareTwoFiles();
    const id = await commentOn(diff.modified, 1, 'Shared');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    assert.equal(await vscode.commands.executeCommand('localReview.openOriginalDiff', managed(id).thread), true);
    const reopened = await waitFor('the comparison', () => activeDiff());
    assert.equal(reopened.original.fsPath, left.fsPath);
    assert.equal(reopened.modified.fsPath, right.fsPath);
  });

  it('follows the code of each file like any other thread', async () => {
    const { right, diff } = await compareTwoFiles();
    const id = await commentOn(diff.modified, 2, 'Why extra?');
    const edit = new vscode.WorkspaceEdit();
    edit.insert(right, new vscode.Position(0, 0), '// new first line\n');
    await vscode.workspace.applyEdit(edit);
    assert.equal(managed(id).thread.range!.start.line, 3);
  });
});

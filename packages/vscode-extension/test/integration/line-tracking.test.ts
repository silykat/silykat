import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { buildAnchorContext, Store } from '@local-review/core';
import type { LocalReviewApi } from '../../src/extension';

const EXTENSION_ID = 'local.local-review';
const LINES = Array.from({ length: 30 }, (_, i) => `const v${i + 1} = ${i + 1};`);

async function waitFor<T>(what: string, probe: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('The comment follows the code when the file changes', () => {
  let api: LocalReviewApi;
  let ws: string;
  let n = 0;

  const managed = (id: string) => api.listThreads().find((t) => t.id === id)!;
  const lines0 = (id: string) => {
    const r = managed(id).thread.range!;
    return [r.start.line, r.end.line];
  };
  const journal = (id: string) => {
    const file = join(ws, '.local-review', 'threads', `${id}.jsonl`);
    return existsSync(file)
      ? readFileSync(file, 'utf8')
          .trimEnd()
          .split('\n')
          .map((l) => JSON.parse(l))
      : [];
  };
  const anchorUpdates = (id: string) => journal(id).filter((e) => e.type === 'anchor.updated');

  /** A fresh file per test, so edits never leak into other suites. */
  async function openFresh(): Promise<{ uri: vscode.Uri; doc: vscode.TextDocument }> {
    const path = join(ws, `us06-${++n}.ts`);
    writeFileSync(path, LINES.join('\n') + '\n');
    const uri = vscode.Uri.file(path);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    return { uri, doc };
  }

  /** Thread on 1-based lines 20-22. */
  async function commentLines20to22(uri: vscode.Uri): Promise<string> {
    const thread = api.controller.createCommentThread(uri, new vscode.Range(19, 0, 21, 5), []);
    await vscode.commands.executeCommand('localReview.submitComment', { thread, text: 'Why a constant here?' });
    return api.listThreads().find((t) => t.thread === thread)!.id;
  }

  async function edit(uri: vscode.Uri, apply: (e: vscode.WorkspaceEdit) => void): Promise<void> {
    const e = new vscode.WorkspaceEdit();
    apply(e);
    assert.equal(await vscode.workspace.applyEdit(e), true);
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
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  it('moves immediately with lines inserted above, without writing yet', async () => {
    const { uri } = await openFresh();
    const id = await commentLines20to22(uri);
    await edit(uri, (e) => e.insert(uri, new vscode.Position(0, 0), 'a\nb\nc\nd\ne\n'));
    await waitFor('the move', () => (lines0(id)[0] === 24 ? true : undefined), 500);
    assert.deepEqual(lines0(id), [24, 26]);
    await new Promise((r) => setTimeout(r, 600)); // longer than the settle delay
    assert.deepEqual(anchorUpdates(id), [], 'nothing is persisted while the file is unsaved');
  });

  it('records the new position on save and keeps it after a reload', async () => {
    const { uri, doc } = await openFresh();
    const id = await commentLines20to22(uri);
    await edit(uri, (e) => e.insert(uri, new vscode.Position(0, 0), 'a\nb\nc\nd\ne\n'));
    await doc.save();
    const [update] = await waitFor('the anchor update', () =>
      anchorUpdates(id).length === 1 ? anchorUpdates(id) : undefined,
    );
    assert.deepEqual(update.anchor.range, { startLine: 25, endLine: 27 });
    assert.equal(update.anchor.snippet, LINES.slice(19, 22).join('\n'));

    await api.reload();
    assert.deepEqual(lines0(id), [24, 26]);
    assert.deepEqual(managed(id).state.anchor.range, { startLine: 25, endLine: 27 });
  });

  it('goes back to its place when the edits are discarded', async () => {
    const { uri } = await openFresh();
    const id = await commentLines20to22(uri);
    await edit(uri, (e) => e.insert(uri, new vscode.Position(0, 0), 'a\nb\nc\n'));
    assert.deepEqual(lines0(id), [22, 24]);
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await waitFor('the way back', () => (lines0(id)[0] === 19 ? true : undefined), 1000);
    assert.deepEqual(lines0(id), [19, 21]);
    await new Promise((r) => setTimeout(r, 600));
    assert.deepEqual(anchorUpdates(id), []);
  });

  it('is back at its place when the file is closed without saving, then reopened', async () => {
    const { uri } = await openFresh();
    const id = await commentLines20to22(uri);
    await edit(uri, (e) => e.insert(uri, new vscode.Position(0, 0), 'a\nb\nc\n'));
    assert.deepEqual(lines0(id), [22, 24]);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    await waitFor('the original position', () => (lines0(id)[0] === 19 ? true : undefined), 2000);
    await new Promise((r) => setTimeout(r, 600));
    assert.deepEqual(anchorUpdates(id), []);
  });

  it('stays attached when editing inside the commented lines', async () => {
    const { uri, doc } = await openFresh();
    const id = await commentLines20to22(uri);
    await edit(uri, (e) => e.insert(uri, new vscode.Position(20, 3), 'X\nY\n')); // inside line 21
    assert.deepEqual(lines0(id), [19, 23]);
    await doc.save();
    const [grown] = await waitFor('the update', () => (anchorUpdates(id).length === 1 ? anchorUpdates(id) : undefined));
    assert.deepEqual(grown.anchor.range, { startLine: 20, endLine: 24 });
    assert.equal(grown.anchor.snippet.split('\n').length, 5, 'the snippet follows the edited code');

    await edit(uri, (e) => e.delete(uri, new vscode.Range(20, 0, 23, 0))); // remove 3 of its 5 lines
    assert.deepEqual(lines0(id), [19, 20]);
  });

  it('follows code moved by another tool while the file is open', async () => {
    const { uri } = await openFresh();
    const id = await commentLines20to22(uri);
    writeFileSync(uri.fsPath, ['// added', '// by', '// git stash', ...LINES].join('\n') + '\n');
    await waitFor('VS Code to reload the file', () => (lines0(id)[0] === 22 ? true : undefined), 5000);
    const [update] = await waitFor('the anchor update', () =>
      anchorUpdates(id).length === 1 ? anchorUpdates(id) : undefined,
    );
    assert.deepEqual(update.anchor.range, { startLine: 23, endLine: 25 });
  });

  it('survives git stash / git stash pop of edits above and inside the commented code', async () => {
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
        cwd: ws,
        encoding: 'utf8',
      });
    const { uri, doc } = await openFresh();
    git('add', uri.fsPath);
    git('commit', '-q', '-m', 'fixture', '--', uri.fsPath);

    const id = await commentLines20to22(uri);
    await edit(uri, (e) => e.insert(uri, new vscode.Position(0, 0), 'a\nb\nc\nd\ne\n'));
    await edit(uri, (e) => e.replace(uri, new vscode.Range(25, 0, 25, 16), 'const v21 = 2100;')); // edit inside
    await doc.save();
    await waitFor('the saved position', () => (anchorUpdates(id).length === 1 ? true : undefined));
    const saved = managed(id).state.anchor;
    assert.deepEqual(saved.range, { startLine: 25, endLine: 27 });

    git('stash', '-q');
    await waitFor(
      'VS Code to reload the stashed file',
      () => (doc.getText().startsWith('const v1 ') ? true : undefined),
      5000,
    );
    await new Promise((r) => setTimeout(r, 800));
    // The edited code is gone from the file: nothing is recorded, and the thread is not left on
    // its old lines. It is outdated: shown on line 1 with the "Outdated" label.
    assert.equal(anchorUpdates(id).length, 1, 'no position recorded while the code is missing');
    assert.equal(managed(id).outdated, true);
    assert.deepEqual(lines0(id), [0, 0]);
    assert.deepEqual(managed(id).state.anchor, saved);

    git('stash', 'pop', '-q');
    await waitFor(
      'VS Code to reload the popped file',
      () => (doc.getText().startsWith('a\n') ? true : undefined),
      5000,
    );
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(managed(id).outdated, false);
    assert.deepEqual(lines0(id), [24, 26], 'back on its code');
    assert.deepEqual(managed(id).state.anchor, saved);
  });

  it('finds its code again when the file changed while VS Code was closed', async () => {
    // A thread on a file that VS Code never opens.
    const rel = `us06-closed-${++n}.ts`;
    const path = join(ws, rel);
    writeFileSync(path, LINES.join('\n') + '\n');
    const t = await new Store(ws).createThread(
      {
        path: rel,
        source: 'worktree',
        ref: null,
        sha: null,
        ...buildAnchorContext(LINES.join('\n'), { startLine: 20, endLine: 22 }),
      },
      { author: 'user', body: 'Why a constant here?', reviewId: null },
    );
    writeFileSync(path, ['// one', '// two', '// three', '// four', ...LINES].join('\n') + '\n');

    await api.reload(); // what happens when VS Code starts
    assert.deepEqual(managed(t.id).state.anchor.range, { startLine: 24, endLine: 26 });
    assert.deepEqual(lines0(t.id), [23, 25]);
    assert.equal(anchorUpdates(t.id).length, 1);
  });
});

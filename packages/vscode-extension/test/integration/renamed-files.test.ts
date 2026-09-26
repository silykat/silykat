import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { LocalReviewApi } from '../../src/extension';

const EXTENSION_ID = 'local.local-review';
const CODE = Array.from({ length: 8 }, (_, i) => `export const value${i + 1} = ${i + 1};`);

async function waitFor<T>(what: string, probe: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('Threads of renamed, moved or deleted files', () => {
  let api: LocalReviewApi;
  let ws: string;
  let n = 0;
  let choices: string[];
  let answer: string | undefined;

  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
      cwd: ws,
      encoding: 'utf8',
    });
  const byPath = (path: string) => api.listThreads().find((t) => t.state.anchor.path === path);
  const managed = (id: string) => api.listThreads().find((t) => t.id === id);

  /** A committed file `<dir>/file-<n>.ts` with a thread on its line 4. */
  async function committedFileWithThread(dir: string): Promise<{ id: string; path: string }> {
    const path = `${dir}/file-${++n}.ts`;
    mkdirSync(join(ws, dir), { recursive: true });
    // Unique content per file: git pairs renames by content, and identical files would be ambiguous.
    writeFileSync(join(ws, path), [`// ${path}`, ...CODE].join('\n') + '\n');
    git('add', path);
    git('commit', '-q', '-m', `add ${path}`, '--', path);
    const uri = vscode.Uri.file(join(ws, path));
    await vscode.workspace.openTextDocument(uri);
    const thread = api.controller.createCommentThread(uri, new vscode.Range(4, 0, 4, 0), []); // "value4"
    await vscode.commands.executeCommand('localReview.submitComment', { thread, text: 'Rename this constant' });
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    return { id: api.listThreads().find((t) => t.thread === thread)!.id, path };
  }

  before(async () => {
    const ext = vscode.extensions.getExtension<LocalReviewApi>(EXTENSION_ID)!;
    api = await ext.activate();
    ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
  });

  beforeEach(async () => {
    rmSync(join(ws, '.local-review'), { recursive: true, force: true });
    await api.reload();
    choices = [];
    answer = undefined;
    api.setChooseHandler(async (message, actions) => {
      choices.push(`${message} [${actions.join('|')}]`);
      return answer;
    });
  });

  after(() => api.setChooseHandler(undefined));

  it('follows a folder renamed and committed (the refactoring case)', async () => {
    const { id, path } = await committedFileWithThread(`old-dir-${n}`);
    const newDir = `new-dir-${n}`;
    git('mv', path.split('/')[0]!, newDir);
    git('commit', '-q', '-m', 'rename the folder');

    await api.reload(); // e.g. the next time VS Code starts
    const t = managed(id)!;
    assert.equal(t.state.anchor.path, `${newDir}/${path.split('/')[1]}`);
    assert.equal(t.outdated, false);
    assert.equal(t.thread.range!.start.line, 4);
    assert.equal(t.uris[0], vscode.Uri.file(join(ws, t.state.anchor.path)).toString());
  });

  it('follows a rename not committed yet', async () => {
    const { id, path } = await committedFileWithThread('staged');
    const moved = `staged/renamed-${n}.ts`;
    git('mv', path, moved);
    await api.reload();
    assert.equal(managed(id)!.state.anchor.path, moved);
    assert.equal(managed(id)!.outdated, false);
    git('commit', '-q', '-m', 'commit the rename'); // leave no pending change to later tests
  });

  it('follows a rename done in VS Code right away', async () => {
    const { id, path } = await committedFileWithThread('in-editor');
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(vscode.Uri.file(join(ws, path)), vscode.Uri.file(join(ws, `in-editor/moved-${n}.ts`)));
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    await waitFor('the thread to follow', () => (managed(id)?.state.anchor.path.includes('moved-') ? true : undefined));
    assert.equal(managed(id)!.thread.uri.fsPath, join(ws, `in-editor/moved-${n}.ts`));
    git('add', '-A', 'in-editor');
    git('commit', '-q', '-m', 'commit the rename');
  });

  it('moves with the renamed file but is outdated when its code changed too', async () => {
    const { id, path } = await committedFileWithThread('changed');
    const moved = `changed/moved-${n}.ts`;
    git('mv', path, moved);
    // Only the commented line changes: still the same file for git (it pairs renames by similarity).
    writeFileSync(
      join(ws, moved),
      [`// ${path}`, ...CODE.map((l, i) => (i === 3 ? 'export const renamed = 4;' : l))].join('\n') + '\n',
    );
    await api.reload();
    assert.equal(managed(id)!.state.anchor.path, moved);
    assert.equal(managed(id)!.outdated, true);
    assert.equal(await api.reveal(id), 'shown', 'no error: the new file exists');
    git('add', '-A', 'changed');
    git('commit', '-q', '-m', 'commit the rename');
  });

  it('offers to resolve or delete a thread whose file was deleted', async () => {
    const { id, path } = await committedFileWithThread('deleted');
    git('rm', '-q', path);
    git('commit', '-q', '-m', 'delete the file');
    await api.reload();
    assert.equal(managed(id)!.outdated, true);

    assert.equal(await api.reveal(id), 'missing');
    assert.deepEqual(choices, [
      `Local Review: the file of this thread no longer exists (${path}). [Resolve|Delete Thread]`,
    ]);

    answer = 'Resolve';
    await api.reveal(id);
    assert.equal(managed(id)!.state.status, 'resolved');

    answer = 'Delete Thread';
    await api.reveal(id);
    assert.equal(managed(id), undefined);
    assert.equal(byPath(path), undefined);
  });

  it('keeps a file comment on a deleted file as a file comment', async () => {
    const path = `whole-${++n}.ts`;
    writeFileSync(join(ws, path), 'export {};\n');
    const uri = vscode.Uri.file(join(ws, path));
    const thread = api.controller.createCommentThread(uri, undefined as unknown as vscode.Range, []);
    await vscode.commands.executeCommand('localReview.submitComment', { thread, text: 'Whole file' });
    const id = api.listThreads().find((t) => t.thread === thread)!.id;
    unlinkSync(join(ws, path));
    await api.reload();
    assert.equal(managed(id)!.outdated, true);
    assert.equal(managed(id)!.thread.range, undefined);
  });
});

import * as assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { LocalReviewApi } from '../../src/extension';

const EXTENSION_ID = 'local.local-review';
const CODE = [
  'export function find(id: string) {',
  '  const user = db.get(id);',
  '  if (!user) {',
  '    return null;',
  '  }',
  '  return user;',
  '}',
];
const FILE = [...Array.from({ length: 10 }, (_, i) => `// header ${i + 1}`), ...CODE, '// end'];

async function waitFor<T>(what: string, probe: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('US-07 — a comment becomes outdated when its code disappears', () => {
  let api: LocalReviewApi;
  let ws: string;
  let n = 0;

  const managed = (id: string) => api.listThreads().find((t) => t.id === id)!;
  const text = (c: vscode.Comment) => (typeof c.body === 'string' ? c.body : c.body.value);
  const anchorUpdates = (id: string) => {
    const f = join(ws, '.local-review', 'threads', `${id}.jsonl`);
    return existsSync(f)
      ? readFileSync(f, 'utf8')
          .trimEnd()
          .split('\n')
          .map((l) => JSON.parse(l))
          .filter((e) => e.type === 'anchor.updated')
      : [];
  };

  /** Fresh file with a thread on the `if (!user)` block (1-based lines 13-15). */
  async function threadOnIfBlock(): Promise<{ id: string; path: string; doc: vscode.TextDocument }> {
    const path = join(ws, `us07-${++n}.ts`);
    writeFileSync(path, FILE.join('\n') + '\n');
    const uri = vscode.Uri.file(path);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    const thread = api.controller.createCommentThread(uri, new vscode.Range(12, 0, 14, 5), []);
    await vscode.commands.executeCommand('localReview.submitComment', { thread, text: 'Throw instead of returning null' });
    return { id: api.listThreads().find((t) => t.thread === thread)!.id, path, doc };
  }

  /** Changes the file as another tool would, and waits until VS Code has reloaded it and the check settled. */
  async function rewriteOutside(path: string, doc: vscode.TextDocument, lines: string[]) {
    const content = lines.join('\n') + '\n';
    writeFileSync(path, content);
    await waitFor('VS Code to reload the file', () => (doc.getText() === content ? true : undefined));
    await new Promise((r) => setTimeout(r, 700));
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

  it('flags the thread as outdated when its code is rewritten elsewhere (AC 1)', async () => {
    const { id, path, doc } = await threadOnIfBlock();
    const rewritten = [...FILE.slice(0, 10), 'export function find(id: string) {', '  return db.getOrThrow(id);', '}', '// end'];
    await rewriteOutside(path, doc, rewritten);

    const t = managed(id);
    assert.equal(t.outdated, true);
    assert.equal(t.thread.label, '⚠️ Outdated · Waiting for Claude');
    assert.deepEqual(anchorUpdates(id), [], 'the recorded anchor is kept as is');
  });

  it('shows it on line 1, off its former lines, quoting the original code (AC 2, 6)', async () => {
    const { id, path, doc } = await threadOnIfBlock();
    await rewriteOutside(path, doc, ['// everything', '// was deleted']);
    const t = managed(id);
    assert.deepEqual([t.thread.range!.start.line, t.thread.range!.end.line], [0, 0]);
    const first = text(t.thread.comments[0]!);
    assert.ok(first.includes('```\n  if (!user) {\n    return null;\n  }\n```'), first);
    assert.ok(first.endsWith('Throw instead of returning null'));
  });

  it('can still be replied to, resolved and deleted (AC 3)', async () => {
    const { id, path, doc } = await threadOnIfBlock();
    await rewriteOutside(path, doc, ['// gone']);
    await vscode.commands.executeCommand('localReview.reply', { thread: managed(id).thread, text: 'Never mind' });
    assert.equal(managed(id).state.comments.length, 2);
    assert.equal(managed(id).outdated, true);
    await vscode.commands.executeCommand('localReview.resolveThread', managed(id).thread);
    assert.equal(managed(id).thread.label, '⚠️ Outdated');
    api.setConfirmHandler(async () => true);
    await vscode.commands.executeCommand('localReview.deleteThread', managed(id).thread);
    api.setConfirmHandler(undefined);
    assert.equal(managed(id), undefined);
  });

  it('edits the comment itself, never the quote', async () => {
    const { id, path, doc } = await threadOnIfBlock();
    await rewriteOutside(path, doc, ['// gone']);
    const c = managed(id).thread.comments[0]!;
    await vscode.commands.executeCommand('localReview.editComment', c);
    assert.equal(text(managed(id).thread.comments[0]!), 'Throw instead of returning null');
    await vscode.commands.executeCommand('localReview.cancelEdit', c);
    assert.ok(text(managed(id).thread.comments[0]!).startsWith('*This code is no longer in the file:*'));
  });

  it('is not outdated after whitespace-only changes, and records the new text (AC 4)', async () => {
    const { id, path, doc } = await threadOnIfBlock();
    const reindented = [...FILE.slice(0, 10), ...CODE.map((l) => '\t' + l.replace(/ {2}/g, '\t')), '// end'];
    await rewriteOutside(path, doc, ['// new first line', ...reindented]);
    const t = managed(id);
    assert.equal(t.outdated, false);
    assert.deepEqual(t.state.anchor.range, { startLine: 14, endLine: 16 });
    assert.equal(t.state.anchor.snippet.split('\n')[0], '\t\tif (!user) {');
  });

  it('comes back on its lines when its code comes back (AC 5)', async () => {
    const { id, path, doc } = await threadOnIfBlock();
    await rewriteOutside(path, doc, ['// gone']);
    assert.equal(managed(id).outdated, true);
    await rewriteOutside(path, doc, FILE);
    const t = managed(id);
    assert.equal(t.outdated, false);
    assert.equal(t.thread.range!.start.line, 12);
    assert.equal(t.thread.label, 'Waiting for Claude');
    assert.ok(!text(t.thread.comments[0]!).includes('no longer in the file'));
  });

  it('is outdated when its line is deleted in the editor, and stays so after saving (PM scenario)', async () => {
    const path = join(ws, `us07-${++n}.ts`);
    writeFileSync(path, FILE.join('\n') + '\n');
    const uri = vscode.Uri.file(path);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    const created = api.controller.createCommentThread(uri, new vscode.Range(13, 0, 13, 5), []); // "return null;"
    await vscode.commands.executeCommand('localReview.submitComment', { thread: created, text: 'Throw here' });
    const id = api.listThreads().find((t) => t.thread === created)!.id;

    const e = new vscode.WorkspaceEdit();
    e.delete(uri, new vscode.Range(13, 0, 14, 0)); // what Cmd+Shift+K does
    await vscode.workspace.applyEdit(e);
    assert.equal(managed(id).outdated, true, 'outdated as soon as the line is gone');
    assert.deepEqual([managed(id).thread.range!.start.line, managed(id).thread.range!.end.line], [0, 0]);

    await doc.save();
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(managed(id).outdated, true);
    assert.deepEqual(anchorUpdates(id), [], 'never re-attached to the code around');
    assert.equal(managed(id).state.anchor.snippet, '    return null;');
  });

  it('attaches again when the deleted code comes back before saving (undo)', async () => {
    const { id, doc } = await threadOnIfBlock();
    const uri = doc.uri;
    const del = new vscode.WorkspaceEdit();
    del.delete(uri, new vscode.Range(12, 0, 15, 0));
    await vscode.workspace.applyEdit(del);
    assert.equal(managed(id).outdated, true);

    await vscode.commands.executeCommand('undo');
    await waitFor('the thread to attach again', () => (managed(id).outdated ? undefined : true), 2000);
    assert.equal(managed(id).thread.range!.start.line, 12);
    assert.equal(managed(id).thread.label, 'Waiting for Claude');
  });

  it('is outdated when the text of its lines is cleared, leaving blank lines', async () => {
    const { id } = await threadOnIfBlock();
    const editor = vscode.window.activeTextEditor!;
    await editor.edit((b) => b.replace(new vscode.Range(12, 0, 14, 3), '')); // select the text, Backspace
    assert.equal(managed(id).outdated, true);
  });

  it('is outdated when other code is pasted over its lines', async () => {
    const { id, doc } = await threadOnIfBlock();
    // Like a paste over the selected lines. Through the editor on purpose: a workspace edit would be
    // reduced by VS Code to the smallest change (the common trailing newline is left out).
    const editor = vscode.window.activeTextEditor!;
    await editor.edit((b) => b.replace(new vscode.Range(12, 0, 15, 0), 'const x = 1;\nconst y = 2;\n'));
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(managed(id).outdated, true);
  });

  it('is outdated after a restart when its code or its file is gone', async () => {
    const a = await threadOnIfBlock();
    const b = await threadOnIfBlock();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    writeFileSync(a.path, '// rewritten while VS Code was closed\n');
    unlinkSync(b.path);
    await api.reload();
    assert.equal(managed(a.id).outdated, true);
    assert.equal(managed(b.id).outdated, true);
  });
});

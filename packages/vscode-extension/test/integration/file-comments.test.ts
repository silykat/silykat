import * as assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { LocalReviewApi } from '../../src/extension';
import { WAIT_MS } from './timing';

const EXTENSION_ID = 'local.local-review';

async function waitFor<T>(what: string, probe: () => T | undefined, timeoutMs = WAIT_MS): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('Comment on a whole file', () => {
  let api: LocalReviewApi;
  let ws: string;
  let uri: vscode.Uri;
  let n = 0;

  const managed = (id: string) => api.listThreads().find((t) => t.id === id)!;

  /** What VS Code hands us for "Comment on File": a new thread without a range. */
  async function commentOnFile(text: string, command = 'localReview.submitComment'): Promise<string> {
    const known = new Set(api.listThreads().map((t) => t.id));
    const thread = api.controller.createCommentThread(uri, undefined as unknown as vscode.Range, []);
    await vscode.commands.executeCommand(command, { thread, text });
    return api.listThreads().find((t) => !known.has(t.id))!.id;
  }

  before(async () => {
    const ext = vscode.extensions.getExtension<LocalReviewApi>(EXTENSION_ID)!;
    api = await ext.activate();
    ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
  });

  beforeEach(async () => {
    uri = vscode.Uri.file(join(ws, `whole-file-${++n}.ts`));
    writeFileSync(uri.fsPath, 'export const a = 1;\nexport const b = 2;\n');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    rmSync(join(ws, '.local-review'), { recursive: true, force: true });
    await api.reload();
  });

  it('offers file comments on workspace files', async () => {
    const doc = await vscode.workspace.openTextDocument(uri);
    const ranges = (await api.controller.commentingRangeProvider!.provideCommentingRanges(
      doc,
      new vscode.CancellationTokenSource().token,
    )) as vscode.CommentingRanges;
    assert.equal(ranges.enableFileComments, true);
  });

  it('opens the native file comment input from "Comment on File"', async () => {
    // The input itself is VS Code's UI; the command must run without error on the active file.
    await vscode.commands.executeCommand('localReview.commentFile', uri);
    assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, uri.fsPath);
  });

  it('saves a comment without any line, and shows it at file level', async () => {
    const id = await commentOnFile('This file should be split');
    const t = managed(id);
    assert.equal(t.state.anchor.range, null);
    assert.equal(t.state.anchor.snippet, '');
    assert.equal(t.thread.range, undefined, 'no line');
    assert.equal(t.uris[0], uri.toString());

    const created = JSON.parse(
      readFileSync(join(ws, '.local-review', 'threads', `${id}.jsonl`), 'utf8').split('\n')[0]!,
    );
    assert.equal(created.anchor.range, null);

    await api.reload();
    assert.equal(managed(id).thread.range, undefined, 'still at file level after a restart');
    assert.equal(managed(id).thread.label, 'Waiting for Claude');
  });

  it('works like any other thread: reply, resolve, review, agent', async () => {
    const id = await commentOnFile('Split it');
    await vscode.commands.executeCommand('localReview.dev.simulateAgentReply', {
      threadId: id,
      body: 'Where?',
      status: 'needs-info',
    });
    await waitFor('the agent reply', () => (managed(id).state.comments.length === 2 ? true : undefined));
    assert.equal(managed(id).thread.label, '❓ Claude is waiting for your reply');
    await vscode.commands.executeCommand('localReview.reply', { thread: managed(id).thread, text: 'Into two modules' });
    assert.equal(managed(id).state.status, 'open');
    await vscode.commands.executeCommand('localReview.resolveThread', managed(id).thread);
    assert.equal(managed(id).state.status, 'resolved');

    const draft = await commentOnFile('A draft on the whole file', 'localReview.startReview');
    assert.equal(managed(draft).state.comments[0]!.isDraft, true);
    assert.equal(managed(draft).thread.range, undefined);
  });

  it('is not moved by edits, since it has no line', async () => {
    const id = await commentOnFile('Whole file');
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, new vscode.Position(0, 0), '// header\n');
    await vscode.workspace.applyEdit(edit);
    await vscode.workspace.save(uri);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(managed(id).thread.range, undefined);
    assert.equal(managed(id).outdated, false);
  });
});

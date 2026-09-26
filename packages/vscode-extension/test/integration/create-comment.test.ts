import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { LocalReviewApi } from '../../src/extension';

const EXTENSION_ID = 'local.local-review';

describe('Direct comment on lines', () => {
  let api: LocalReviewApi;
  let ws: string;
  let uri: vscode.Uri;

  const storeDir = () => join(ws, '.local-review');
  const threadFiles = () => (existsSync(join(storeDir(), 'threads')) ? readdirSync(join(storeDir(), 'threads')) : []);
  const journal = (file: string) =>
    readFileSync(join(storeDir(), 'threads', file), 'utf8')
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l));

  async function comment(range: vscode.Range, text: string): Promise<vscode.CommentThread> {
    const thread = api.controller.createCommentThread(uri, range, []);
    await vscode.commands.executeCommand('localReview.submitComment', { thread, text });
    return thread;
  }

  before(async () => {
    const ext = vscode.extensions.getExtension<LocalReviewApi>(EXTENSION_ID);
    assert.ok(ext, 'extension not found');
    api = await ext.activate();
    ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    uri = vscode.Uri.file(join(ws, 'sample.ts'));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  });

  beforeEach(async () => {
    rmSync(storeDir(), { recursive: true, force: true });
    await api.reload();
  });

  it('stores a direct comment with its anchor and snippet', async () => {
    const thread = await comment(new vscode.Range(9, 0, 11, 5), 'Hello **world**');

    const files = threadFiles();
    assert.equal(files.length, 1);
    const [created, added] = journal(files[0]!);
    assert.equal(created.type, 'thread.created');
    assert.equal(created.anchor.path, 'sample.ts');
    assert.deepEqual(created.anchor.range, { startLine: 10, endLine: 12 });
    assert.equal(created.anchor.snippet, 'const line10 = 10;\nconst line11 = 11;\nconst line12 = 12;');
    assert.deepEqual(created.anchor.contextBefore, ['const line7 = 7;', 'const line8 = 8;', 'const line9 = 9;']);
    assert.equal(added.type, 'comment.added');
    assert.equal(added.body, 'Hello **world**');
    assert.equal(added.reviewId, null);

    assert.equal(thread.comments.length, 1);
    const body = thread.comments[0]!.body as vscode.MarkdownString;
    assert.equal(body.value, 'Hello **world**');
    assert.equal(body.isTrusted, false);
  });

  it('ignores an empty comment', async () => {
    const thread = await comment(new vscode.Range(2, 0, 2, 0), '   ');
    assert.deepEqual(threadFiles(), []);
    thread.dispose();
  });

  it('cancel closes the new thread without writing anything', async () => {
    const thread = api.controller.createCommentThread(uri, new vscode.Range(3, 0, 3, 0), []);
    await vscode.commands.executeCommand('localReview.cancelNewThread', { thread, text: 'draft text' });
    assert.deepEqual(threadFiles(), []);
    assert.equal(api.listThreads().length, 0);
  });

  it('comes back on the same lines after a reload', async () => {
    await comment(new vscode.Range(9, 0, 11, 5), 'persist me');
    await api.reload();

    const threads = api.listThreads();
    assert.equal(threads.length, 1);
    assert.deepEqual(threads[0]!.state.anchor.range, { startLine: 10, endLine: 12 });
    assert.equal(threads[0]!.thread.range!.start.line, 9);
    assert.equal(threads[0]!.thread.range!.end.line, 11);
    assert.equal(threads[0]!.thread.uri.fsPath, uri.fsPath);
    assert.equal(threads[0]!.thread.collapsibleState, vscode.CommentThreadCollapsibleState.Expanded);
  });

  it('keeps .local-review out of git status', async () => {
    await comment(new vscode.Range(0, 0, 0, 0), 'git hygiene');
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: ws,
      encoding: 'utf8',
    });
    assert.ok(status.includes('sample.ts'), status);
    assert.ok(!status.includes('.local-review'), status);
    const exclude = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
      cwd: ws,
      encoding: 'utf8',
    }).trim();
    const lines = readFileSync(join(ws, exclude), 'utf8').split('\n');
    assert.equal(lines.filter((l) => l === '/.local-review/').length, 1);
  });

  it('creates two separate threads for two places', async () => {
    await comment(new vscode.Range(1, 0, 1, 0), 'first');
    await comment(new vscode.Range(20, 0, 22, 0), 'second');
    assert.equal(threadFiles().length, 2);
    const ranges = api
      .listThreads()
      .map((t) => t.state.anchor.range)
      .sort((a, b) => a!.startLine - b!.startLine);
    assert.deepEqual(ranges, [
      { startLine: 2, endLine: 2 },
      { startLine: 21, endLine: 22 }, // ends at column 0 of line 23: that line is excluded
    ]);
  });

  it('does not offer comments inside the store itself', async () => {
    await comment(new vscode.Range(0, 0, 0, 0), 'x');
    const file = join(storeDir(), 'threads', threadFiles()[0]!);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const ranges = await api.controller.commentingRangeProvider!.provideCommentingRanges(
      doc,
      new vscode.CancellationTokenSource().token,
    );
    assert.deepEqual(ranges, { enableFileComments: false, ranges: [] });
  });
});

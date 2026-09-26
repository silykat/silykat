import * as assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { LocalReviewApi } from '../../src/extension';

const EXTENSION_ID = 'local.local-review';

async function waitFor<T>(what: string, probe: () => T | undefined, timeoutMs = 1500): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('Edit / delete my comments and threads', () => {
  let api: LocalReviewApi;
  let ws: string;
  let uri: vscode.Uri;
  let confirmations: string[];
  let answer: boolean;

  const managed = (id: string) => api.listThreads().find((t) => t.id === id);
  const comments = (id: string) => managed(id)!.thread.comments as (vscode.Comment & { commentId: string })[];
  const text = (c: vscode.Comment) => (typeof c.body === 'string' ? c.body : c.body.value);
  const events = (id: string) =>
    readFileSync(join(ws, '.local-review', 'threads', `${id}.jsonl`), 'utf8')
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l).type as string);

  async function newThread(line: number, body = 'Rename this variable'): Promise<string> {
    const thread = api.controller.createCommentThread(uri, new vscode.Range(line, 0, line, 0), []);
    await vscode.commands.executeCommand('localReview.submitComment', { thread, text: body });
    return api.listThreads().find((t) => t.thread === thread)!.id;
  }

  async function withAgentReply(line: number): Promise<string> {
    const id = await newThread(line);
    await vscode.commands.executeCommand('localReview.dev.simulateAgentReply', {
      threadId: id,
      body: 'Which name?',
      status: 'needs-info',
    });
    await waitFor('the agent reply', () => (managed(id)!.thread.comments.length === 2 ? true : undefined));
    return id;
  }

  before(async () => {
    const ext = vscode.extensions.getExtension<LocalReviewApi>(EXTENSION_ID)!;
    api = await ext.activate();
    ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    uri = vscode.Uri.file(join(ws, 'sample.ts'));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  });

  beforeEach(async () => {
    rmSync(join(ws, '.local-review'), { recursive: true, force: true });
    await api.reload();
    confirmations = [];
    answer = true;
    api.setConfirmHandler(async (message, detail) => {
      confirmations.push(`${message} ${detail}`);
      return answer;
    });
  });

  after(() => api.setConfirmHandler(undefined));

  it('edits my comment, then saves it and marks it edited', async () => {
    const id = await newThread(3);
    const c = comments(id)[0]!;
    await vscode.commands.executeCommand('localReview.editComment', c);
    assert.equal(comments(id)[0]!.mode, vscode.CommentMode.Editing);

    c.body = 'Rename it to `userCount`'; // what VS Code does when the user types
    await vscode.commands.executeCommand('localReview.saveEdit', c);

    const saved = comments(id)[0]!;
    assert.equal(saved.mode, vscode.CommentMode.Preview);
    assert.equal(text(saved), 'Rename it to `userCount`');
    assert.equal(saved.label, 'edited');
    assert.equal(events(id).at(-1), 'comment.edited');

    await api.reload();
    assert.equal(comments(id)[0]!.label, 'edited');
    assert.equal(text(comments(id)[0]!), 'Rename it to `userCount`');
  });

  it('cancels an edit without writing anything', async () => {
    const id = await newThread(4);
    const c = comments(id)[0]!;
    await vscode.commands.executeCommand('localReview.editComment', c);
    c.body = 'changed my mind';
    await vscode.commands.executeCommand('localReview.cancelEdit', c);
    assert.equal(comments(id)[0]!.mode, vscode.CommentMode.Preview);
    assert.equal(text(comments(id)[0]!), 'Rename this variable');
    assert.deepEqual(events(id), ['thread.created', 'comment.added']);
  });

  it('refuses to save an empty edit', async () => {
    const id = await newThread(5);
    const c = comments(id)[0]!;
    await vscode.commands.executeCommand('localReview.editComment', c);
    c.body = '   ';
    await vscode.commands.executeCommand('localReview.saveEdit', c);
    assert.deepEqual(events(id), ['thread.created', 'comment.added']);
  });

  it('keeps an edit in progress when the agent replies meanwhile', async () => {
    const id = await newThread(6);
    const c = comments(id)[0]!;
    await vscode.commands.executeCommand('localReview.editComment', c);
    c.body = 'half-typed edit';
    await vscode.commands.executeCommand('localReview.dev.simulateAgentReply', {
      threadId: id,
      body: 'Hi',
      status: 'none',
    });
    await waitFor('the agent reply', () => (comments(id).length === 2 ? true : undefined));
    assert.equal(comments(id)[0]!.mode, vscode.CommentMode.Editing);
    assert.equal(text(comments(id)[0]!), 'half-typed edit');
  });

  it('deletes my comment after confirmation', async () => {
    const id = await withAgentReply(7);
    await vscode.commands.executeCommand('localReview.reply', { thread: managed(id)!.thread, text: 'typo reply' });
    await vscode.commands.executeCommand('localReview.deleteComment', comments(id)[2]!);
    assert.equal(confirmations.length, 1);
    assert.deepEqual(comments(id).map(text), ['Rename this variable', 'Which name?']);
    assert.equal(events(id).at(-1), 'comment.deleted');
  });

  it('does nothing when the deletion is not confirmed', async () => {
    const id = await newThread(8);
    answer = false;
    await vscode.commands.executeCommand('localReview.deleteComment', comments(id)[0]!);
    assert.equal(comments(id).length, 1);
    assert.deepEqual(events(id), ['thread.created', 'comment.added']);
  });

  it('never edits or deletes the agent’s comments', async () => {
    const id = await withAgentReply(9);
    const agentComment = comments(id)[1]!;
    assert.equal(agentComment.contextValue, 'author-agent');
    await vscode.commands.executeCommand('localReview.editComment', agentComment);
    assert.equal(comments(id)[1]!.mode, vscode.CommentMode.Preview);
    await vscode.commands.executeCommand('localReview.deleteComment', agentComment);
    assert.equal(comments(id).length, 2);
    assert.equal(confirmations.length, 0);
  });

  it('removes the thread with its only comment', async () => {
    const id = await newThread(10);
    await vscode.commands.executeCommand('localReview.deleteComment', comments(id)[0]!);
    assert.match(confirmations[0]!, /thread will be deleted too/);
    assert.equal(managed(id), undefined);
    assert.deepEqual(events(id).slice(-2), ['comment.deleted', 'thread.deleted']);
    await api.reload();
    assert.equal(managed(id), undefined);
  });

  it('deletes a whole thread, agent replies included', async () => {
    const id = await withAgentReply(11);
    await vscode.commands.executeCommand('localReview.deleteThread', managed(id)!.thread);
    assert.match(confirmations[0]!, /2 comments/);
    assert.equal(managed(id), undefined);
    await api.reload();
    assert.equal(managed(id), undefined);
    assert.equal(events(id).at(-1), 'thread.deleted', 'the journal keeps the history');
  });
});

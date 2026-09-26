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

describe('US-04 — resolve / reopen a thread', () => {
  let api: LocalReviewApi;
  let ws: string;
  let uri: vscode.Uri;

  const managed = (id: string) => api.listThreads().find((t) => t.id === id)!;
  const lastEvent = (id: string) => {
    const lines = readFileSync(join(ws, '.local-review', 'threads', `${id}.jsonl`), 'utf8')
      .trimEnd()
      .split('\n');
    return JSON.parse(lines[lines.length - 1]!);
  };

  async function newThread(line: number): Promise<string> {
    const thread = api.controller.createCommentThread(uri, new vscode.Range(line, 0, line, 0), []);
    await vscode.commands.executeCommand('localReview.submitComment', { thread, text: 'Rename this variable' });
    return api.listThreads().find((t) => t.thread === thread)!.id;
  }

  const resolve = (id: string) => vscode.commands.executeCommand('localReview.resolveThread', managed(id).thread);
  const reopen = (id: string) => vscode.commands.executeCommand('localReview.reopenThread', managed(id).thread);

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
  });

  it('resolves and collapses the thread (AC 1)', async () => {
    const id = await newThread(3);
    await resolve(id);

    const t = managed(id);
    assert.equal(t.state.status, 'resolved');
    assert.equal(t.thread.state, vscode.CommentThreadState.Resolved);
    assert.equal(t.thread.collapsibleState, vscode.CommentThreadCollapsibleState.Collapsed);
    assert.equal(t.thread.label, undefined);
    assert.equal(t.thread.contextValue, 'lr resolved');
    assert.deepEqual(
      [lastEvent(id).type, lastEvent(id).by, lastEvent(id).status],
      ['status.changed', 'user', 'resolved'],
    );
  });

  it('can resolve a thread the agent is waiting on', async () => {
    const id = await newThread(4);
    await vscode.commands.executeCommand('localReview.dev.simulateAgentReply', {
      threadId: id,
      body: 'Which name?',
      status: 'needs-info',
    });
    await waitFor('the agent question', () => (managed(id).state.status === 'needs-info' ? true : undefined));
    await resolve(id);
    assert.equal(managed(id).state.status, 'resolved');
  });

  it('reopens it as waiting for the agent (AC 2)', async () => {
    const id = await newThread(5);
    await resolve(id);
    await reopen(id);

    const t = managed(id);
    assert.equal(t.state.status, 'open');
    assert.equal(t.thread.state, vscode.CommentThreadState.Unresolved);
    assert.equal(t.thread.collapsibleState, vscode.CommentThreadCollapsibleState.Expanded);
    assert.equal(t.thread.label, 'Waiting for Claude');
  });

  it('reopens a resolved thread when the user replies (AC 3)', async () => {
    const id = await newThread(6);
    await resolve(id);
    await vscode.commands.executeCommand('localReview.reply', {
      thread: managed(id).thread,
      text: 'Actually, one more thing',
    });
    assert.equal(managed(id).state.status, 'open');
    assert.equal(managed(id).thread.state, vscode.CommentThreadState.Unresolved);
  });

  it('does not let the simulated agent reply to, or resolve, a resolved thread (AC 4)', async () => {
    const id = await newThread(7);
    await resolve(id);
    const ok = await vscode.commands.executeCommand('localReview.dev.simulateAgentReply', {
      threadId: id,
      body: 'x',
      status: 'addressed',
    });
    assert.equal(ok, false);
    assert.equal(managed(id).state.comments.length, 1);
  });

  it('keeps the resolved state after a reload (AC 5)', async () => {
    const id = await newThread(8);
    await resolve(id);
    await api.reload();
    const t = managed(id);
    assert.equal(t.thread.state, vscode.CommentThreadState.Resolved);
    assert.equal(t.thread.collapsibleState, vscode.CommentThreadCollapsibleState.Collapsed);
  });
});

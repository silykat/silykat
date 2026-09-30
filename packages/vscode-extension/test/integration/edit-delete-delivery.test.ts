import * as assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { localReviewHome, SessionRegistry, Store, topicOf, type Delivery } from '@local-review/core';
import type { LocalReviewApi } from '../../src/extension';
import type { LrComment } from '../../src/render';
import { WAIT_MS } from './timing';

const EXTENSION_ID = 'local.local-review';

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs = WAIT_MS,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('Edited and deleted comments reach the subscribed agent sessions', () => {
  let api: LocalReviewApi;
  let ws: string;
  let uri: vscode.Uri;
  let registry: SessionRegistry;
  let asked: string[];

  const managed = (id: string) => api.listThreads().find((t) => t.id === id);
  const comments = (id: string) => managed(id)!.thread.comments as LrComment[];
  const inbox = async (): Promise<Delivery[]> => (await registry.readInbox('dev')).deliveries;
  const kinds = async () => (await inbox()).map((d) => [d.kind, d.threadIds.length]);

  async function newThread(text: string, line: number, command = 'localReview.submitComment'): Promise<string> {
    const thread = api.controller.createCommentThread(uri, new vscode.Range(line, 0, line, 0), []);
    await vscode.commands.executeCommand(command, { thread, text });
    return api.listThreads().find((t) => t.thread === thread)!.id;
  }

  async function edit(id: string, index: number, text: string): Promise<void> {
    const c = comments(id)[index]!;
    await vscode.commands.executeCommand('localReview.editComment', c);
    c.body = text; // what VS Code does when the user types
    await vscode.commands.executeCommand('localReview.saveEdit', c);
  }

  before(async () => {
    const ext = vscode.extensions.getExtension<LocalReviewApi>(EXTENSION_ID)!;
    api = await ext.activate();
    ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    uri = vscode.Uri.file(join(ws, 'sample.ts'));
    registry = new SessionRegistry(localReviewHome());
    api.setConfirmHandler(async () => true);
    api.setSummaryPrompt(async () => '');
    api.setNoSubscriberPrompt(async (message) => (asked.push(message), 'Publish'));
  });

  beforeEach(async () => {
    rmSync(registry.dir, { recursive: true, force: true });
    rmSync(join(ws, '.local-review'), { recursive: true, force: true });
    await api.reload();
    asked = [];
    await registry.register({
      id: 'dev',
      agent: 'Claude',
      cwd: ws,
      branch: null,
      pid: process.pid, // alive for as long as the test runs
      startedAt: new Date().toISOString(),
      push: true,
    });
    await registry.subscribe('dev', await topicOf(uri.fsPath), 'modified');
  });

  after(async () => {
    rmSync(registry.dir, { recursive: true, force: true });
    api.setConfirmHandler(undefined);
    api.setSummaryPrompt(undefined);
    api.setNoSubscriberPrompt(async () => 'Publish'); // as for every test file
    await vscode.workspace.getConfiguration('localReview').update('pushToAgents', undefined, true);
  });

  it('tells the agent about an edited comment, and hands a handled thread back to it', async () => {
    const id = await newThread('Rename XXX to YYY', 1);
    await new Store(ws).addComment(
      id,
      { author: 'agent', agent: 'Claude', body: 'Done', reviewId: null },
      { status: 'addressed' },
    );
    await waitFor('the agent reply', () => (comments(id).length === 2 ? true : undefined));
    await new Promise((r) => setTimeout(r, 20)); // the edit comes strictly after the reply

    await edit(id, 0, 'Rename XXX to GGG');
    await waitFor('the edit delivery', async () => ((await inbox()).length === 2 ? true : undefined));
    assert.deepEqual(await kinds(), [
      ['comment', 1],
      ['edit', 1],
    ]);
    const t = managed(id)!;
    assert.equal(t.state.status, 'open');
    assert.equal(t.thread.label, 'Waiting for Claude');
    assert.equal(comments(id)[0]!.label, 'edited after Claude replied');
  });

  it('says nothing about a draft edited: nobody saw it', async () => {
    const id = await newThread('Draft', 1, 'localReview.addToReview');
    await edit(id, 0, 'Draft, reworded');
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(await inbox(), []);
  });

  it('tells the agent about deleted comments and threads', async () => {
    const one = await newThread('Delete me', 1);
    await vscode.commands.executeCommand('localReview.deleteComment', comments(one)[0]!); // the last: the thread goes
    const two = await newThread('Delete this thread', 3);
    await vscode.commands.executeCommand('localReview.deleteThread', managed(two)!.thread);
    await waitFor('the deletions', async () => ((await inbox()).length === 4 ? true : undefined));
    const d = await inbox();
    assert.deepEqual(
      d.map((x) => [x.kind, x.threadIds[0]]),
      [
        ['comment', one],
        ['delete', one],
        ['comment', two],
        ['delete', two],
      ],
    );
  });

  it('sends nothing, and asks nothing, when pushing to agents is off', async () => {
    await vscode.workspace.getConfiguration('localReview').update('pushToAgents', false, true);
    rmSync(registry.dir, { recursive: true, force: true }); // nobody subscribed: still no question
    const id = await newThread('Not sent', 1);
    assert.ok(managed(id));
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(asked, []);
    await vscode.workspace.getConfiguration('localReview').update('pushToAgents', undefined, true);
  });
});

import * as assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { SilykatApi } from '../../src/extension';

const EXTENSION_ID = 'silykat.silykat';

async function waitFor<T>(what: string, probe: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('Discard a review, and draft replies', () => {
  let api: SilykatApi;
  let ws: string;
  let uri: vscode.Uri;
  let confirmations: string[];
  let answer: boolean;

  const managed = (id: string) => api.listThreads().find((t) => t.id === id);
  const reviewEvents = () => {
    const dir = join(ws, '.silykat', 'reviews');
    return existsSync(dir)
      ? readdirSync(dir).flatMap((f) =>
          readFileSync(join(dir, f), 'utf8')
            .trimEnd()
            .split('\n')
            .map((l) => JSON.parse(l).type as string),
        )
      : [];
  };

  async function onNewThread(command: string, line: number, text: string): Promise<string> {
    const thread = api.controller.createCommentThread(uri, new vscode.Range(line, 0, line, 0), []);
    await vscode.commands.executeCommand(command, { thread, text });
    return api.listThreads().find((t) => t.thread === thread)!.id;
  }

  /** A published thread where the agent asked a question. */
  async function questionThread(line: number): Promise<string> {
    const id = await onNewThread('silykat.submitComment', line, 'Why null?');
    await vscode.commands.executeCommand('silykat.dev.simulateAgentReply', {
      threadId: id,
      body: 'Which error then?',
      status: 'needs-info',
    });
    await waitFor('the agent question', () => (managed(id)!.state.status === 'needs-info' ? true : undefined));
    return id;
  }

  before(async () => {
    const ext = vscode.extensions.getExtension<SilykatApi>(EXTENSION_ID)!;
    api = await ext.activate();
    ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    uri = vscode.Uri.file(join(ws, 'sample.ts'));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  });

  beforeEach(async () => {
    rmSync(join(ws, '.silykat'), { recursive: true, force: true });
    await api.reload();
    confirmations = [];
    answer = true;
    api.setConfirmHandler(async (message) => {
      confirmations.push(message);
      return answer;
    });
    api.setSummaryPrompt(async () => '');
  });

  after(() => {
    api.setConfirmHandler(undefined);
    api.setSummaryPrompt(undefined);
  });

  it('adds a draft reply to a published thread; the agent still sees the old messages only', async () => {
    const id = await questionThread(3);
    await vscode.commands.executeCommand('silykat.startReview');
    await vscode.commands.executeCommand('silykat.addToReview', {
      thread: managed(id)!.thread,
      text: 'A NotFoundError',
    });

    const t = managed(id)!;
    assert.deepEqual(
      t.state.comments.map((c) => c.isDraft),
      [false, false, true],
    );
    assert.equal(t.thread.comments[2]!.label, 'Pending');
    assert.equal(t.thread.contextValue, 'slk needs-info', 'still a published thread');
    assert.equal(t.thread.label, '❓ Claude is waiting for your reply', 'nothing changes for the agent yet');
    assert.equal(api.reviewStatusText(), '$(comment-draft) Review · 1');
  });

  it('publishes the draft reply on submit and hands the thread back to the agent', async () => {
    const id = await questionThread(4);
    await vscode.commands.executeCommand('silykat.startReview');
    await vscode.commands.executeCommand('silykat.addToReview', {
      thread: managed(id)!.thread,
      text: 'A NotFoundError',
    });
    await vscode.commands.executeCommand('silykat.submitReview');

    await waitFor('the thread to be open again', () => (managed(id)!.state.status === 'open' ? true : undefined));
    assert.equal(managed(id)!.state.comments[2]!.isDraft, false);
    assert.equal(managed(id)!.thread.label, 'Waiting for Claude');
  });

  it('can still reply right away during a review ("Reply Now")', async () => {
    const id = await questionThread(5);
    await vscode.commands.executeCommand('silykat.startReview');
    await vscode.commands.executeCommand('silykat.replyNow', { thread: managed(id)!.thread, text: 'now' });
    assert.equal(managed(id)!.state.comments[2]!.isDraft, false);
    assert.equal(managed(id)!.state.status, 'open');
  });

  it('discards the review: drafts and draft-only threads go, published threads stay', async () => {
    const published = await questionThread(6);
    const draftOnly = await onNewThread('silykat.startReview', 8, 'draft thread');
    await vscode.commands.executeCommand('silykat.addToReview', {
      thread: managed(published)!.thread,
      text: 'draft reply',
    });
    assert.equal(api.reviewStatusText(), '$(comment-draft) Review · 2');

    const dropped = await vscode.commands.executeCommand<number>('silykat.discardReview');
    assert.equal(dropped, 2);
    assert.deepEqual(confirmations, ['Delete 2 pending comments?']);
    assert.equal(managed(draftOnly), undefined, 'the draft-only thread disappeared');
    assert.deepEqual(
      managed(published)!.state.comments.map((c) => c.body),
      ['Why null?', 'Which error then?'],
    );
    assert.equal(managed(published)!.state.status, 'needs-info', 'untouched');
    assert.equal(api.reviewStatusText(), undefined);
    assert.deepEqual(reviewEvents(), ['review.started', 'review.discarded']);

    await api.reload();
    assert.equal(managed(draftOnly), undefined);
    assert.equal(managed(published)!.state.comments.length, 2);
  });

  it('keeps everything when the discard is not confirmed', async () => {
    const id = await onNewThread('silykat.startReview', 3, 'keep me');
    answer = false;
    assert.equal(await vscode.commands.executeCommand<number>('silykat.discardReview'), 0);
    assert.equal(managed(id)!.state.comments[0]!.isDraft, true);
    assert.equal(api.reviewStatusText(), '$(comment-draft) Review · 1');
  });

  it('says there is nothing to submit when the review holds no draft', async () => {
    await vscode.commands.executeCommand('silykat.startReview');
    assert.equal(await vscode.commands.executeCommand<number>('silykat.submitReview'), 0);
    assert.equal(api.reviewsInProgress().length, 1);
  });
});

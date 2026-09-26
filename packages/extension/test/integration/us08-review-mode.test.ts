import * as assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { LocalReviewApi } from '../../src/extension';

const EXTENSION_ID = 'local.local-review';

describe('US-08 — review mode: drafts, then submit', () => {
  let api: LocalReviewApi;
  let ws: string;
  let uri: vscode.Uri;
  let extensionPath: string;

  const managed = (id: string) => api.listThreads().find((t) => t.id === id)!;
  const byThread = (thread: vscode.CommentThread) => api.listThreads().find((t) => t.thread === thread)!;
  const reviewJournals = () => {
    const dir = join(ws, '.local-review', 'reviews');
    return existsSync(dir)
      ? readdirSync(dir).map((f) =>
          readFileSync(join(dir, f), 'utf8')
            .trimEnd()
            .split('\n')
            .map((l) => JSON.parse(l)),
        )
      : [];
  };

  /** Runs a button of a new thread's input on `line` with `text`. */
  async function onNewThread(command: string, line: number, text: string): Promise<string> {
    const thread = api.controller.createCommentThread(uri, new vscode.Range(line, 0, line, 0), []);
    await vscode.commands.executeCommand(command, { thread, text });
    return byThread(thread).id;
  }

  before(async () => {
    const ext = vscode.extensions.getExtension<LocalReviewApi>(EXTENSION_ID)!;
    api = await ext.activate();
    extensionPath = ext.extensionPath;
    ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    uri = vscode.Uri.file(join(ws, 'sample.ts'));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  });

  beforeEach(async () => {
    rmSync(join(ws, '.local-review'), { recursive: true, force: true });
    await api.reload();
    api.setSummaryPrompt(async () => '');
  });

  after(() => api.setSummaryPrompt(undefined));

  it('"Start Review" saves the comment as a draft and shows "Review · 1" (AC 1, 2)', async () => {
    assert.equal(api.reviewStatusText(), undefined, 'no review yet');
    const id = await onNewThread('localReview.startReview', 3, 'First remark');

    const t = managed(id);
    assert.equal(t.state.comments[0]!.isDraft, true);
    assert.equal(t.thread.comments[0]!.label, 'Pending');
    assert.equal(t.thread.label, 'Pending');
    assert.equal(t.thread.contextValue, 'lr draft open');
    assert.equal(api.reviewStatusText(), '$(comment-draft) Review · 1');
    assert.deepEqual(
      reviewJournals().map((events) => events.map((e) => e.type)),
      [['review.started']],
    );
  });

  it('adds to the review, or comments now, while it is in progress (AC 3)', async () => {
    await onNewThread('localReview.startReview', 3, 'draft 1');
    const draft = await onNewThread('localReview.addToReview', 5, 'draft 2');
    const direct = await onNewThread('localReview.commentNow', 7, 'right now');
    assert.equal(managed(draft).state.comments[0]!.isDraft, true);
    assert.equal(managed(direct).state.comments[0]!.isDraft, false);
    assert.equal(managed(direct).thread.label, 'Waiting for Claude');
    assert.equal(reviewJournals().length, 1, 'a single review');
  });

  it('adds a draft reply to a draft thread', async () => {
    const id = await onNewThread('localReview.startReview', 3, 'draft');
    await vscode.commands.executeCommand('localReview.addToReview', { thread: managed(id).thread, text: 'and more' });
    assert.deepEqual(
      managed(id).state.comments.map((c) => c.isDraft),
      [true, true],
    );
    assert.equal(api.reviewStatusText(), '$(comment-draft) Review · 2');
  });

  it('keeps the counter in line with the drafts (AC 4)', async () => {
    await onNewThread('localReview.startReview', 3, 'one');
    const two = await onNewThread('localReview.addToReview', 5, 'two');
    assert.equal(api.reviewStatusText(), '$(comment-draft) Review · 2');
    // Deleting a draft needs no confirmation: it was never seen by anyone.
    await vscode.commands.executeCommand('localReview.deleteThread', managed(two).thread);
    assert.equal(api.reviewStatusText(), '$(comment-draft) Review · 1');
  });

  it('goes to a pending comment (AC 5)', async () => {
    const id = await onNewThread('localReview.startReview', 12, 'look here');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('localReview.revealThread', id);
    const editor = vscode.window.activeTextEditor!;
    assert.equal(editor.document.uri.fsPath, uri.fsPath);
    assert.equal(editor.selection.active.line, 12);
    assert.equal(managed(id).thread.collapsibleState, vscode.CommentThreadCollapsibleState.Expanded);
  });

  it('submits the review with a summary: drafts are published (AC 6)', async () => {
    const a = await onNewThread('localReview.startReview', 3, 'one');
    const b = await onNewThread('localReview.addToReview', 5, 'two');
    api.setSummaryPrompt(async () => '  Looks good overall  ');
    const n = await vscode.commands.executeCommand<number>('localReview.submitReview');

    assert.equal(n, 2);
    for (const id of [a, b]) {
      assert.equal(managed(id).state.comments[0]!.isDraft, false);
      assert.equal(managed(id).thread.comments[0]!.label, undefined);
      assert.equal(managed(id).thread.label, 'Waiting for Claude');
      assert.equal(managed(id).thread.contextValue, 'lr open');
    }
    const [events] = reviewJournals();
    assert.deepEqual(
      events!.map((e) => [e.type, e.summary]),
      [
        ['review.started', undefined],
        ['review.submitted', 'Looks good overall'],
      ],
    );
    assert.equal(api.reviewStatusText(), undefined, 'no review in progress any more');
  });

  it('cancels the submission when the summary is dismissed with Esc (AC 7)', async () => {
    const id = await onNewThread('localReview.startReview', 3, 'one');
    api.setSummaryPrompt(async () => undefined);
    assert.equal(await vscode.commands.executeCommand<number>('localReview.submitReview'), 0);
    assert.equal(managed(id).state.comments[0]!.isDraft, true);
    assert.equal(api.reviewStatusText(), '$(comment-draft) Review · 1');
  });

  it('keeps the review and its drafts after a restart (AC 8)', async () => {
    const id = await onNewThread('localReview.startReview', 3, 'survive me');
    await api.reload();
    assert.equal(managed(id).state.comments[0]!.isDraft, true);
    assert.equal(api.reviewStatusText(), '$(comment-draft) Review · 1');
    assert.equal(api.reviewsInProgress().length, 1);
  });

  it('hides drafts from the agent until the review is submitted (AC 9)', async () => {
    const id = await onNewThread('localReview.startReview', 3, 'secret for now');
    const viaCommand = await vscode.commands.executeCommand('localReview.dev.simulateAgentReply', {
      threadId: id,
      body: 'I saw it',
      status: 'none',
    });
    assert.equal(viaCommand, false, 'the thread is not offered to the agent');

    const code = await new Promise<number | null>((resolve) =>
      fork(join(extensionPath, 'dist', 'fake-agent.js'), ['--root', ws, '--thread', id, '--body', 'I saw it'], {
        stdio: 'ignore',
      }).on('exit', resolve),
    );
    assert.equal(code, 1, 'a direct write by the agent is refused too');
    assert.equal(managed(id).state.comments.length, 1);
  });

  it('says so when there is nothing to submit', async () => {
    await vscode.commands.executeCommand('localReview.startReview'); // from the command palette
    assert.equal(api.reviewStatusText(), '$(comment-draft) Review · 0');
    assert.equal(await vscode.commands.executeCommand<number>('localReview.submitReview'), 0);
    assert.equal(api.reviewsInProgress().length, 1, 'still in progress');
  });
});

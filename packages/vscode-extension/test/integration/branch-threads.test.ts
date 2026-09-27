import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { buildAnchorContext, Store } from '@local-review/core';
import type { LocalReviewApi } from '../../src/extension';

const EXTENSION_ID = 'local.local-review';

describe('Threads belong to their git branch', () => {
  let api: LocalReviewApi;
  let ws: string;
  let uri: vscode.Uri;
  let home: string; // the branch the workspace was on

  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
      cwd: ws,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  const checkout = async (...args: string[]) => {
    git('checkout', '-q', ...args);
    await api.refreshBranches();
  };
  const shown = (id: string) => api.listThreads().some((t) => t.id === id);
  const hidden = (id: string) => api.hiddenThreads().includes(id);
  const stateOf = async (id: string) => (await new Store(ws).loadThread(id)).state;

  async function comment(text: string, line: number, command = 'localReview.submitComment', file = uri) {
    const thread = api.controller.createCommentThread(file, new vscode.Range(line, 0, line, 0), []);
    await vscode.commands.executeCommand(command, { thread, text });
    return api.listThreads().find((t) => t.thread === thread)!.id;
  }

  before(async () => {
    const ext = vscode.extensions.getExtension<LocalReviewApi>(EXTENSION_ID)!;
    api = await ext.activate();
    ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    uri = vscode.Uri.file(join(ws, 'sample.ts'));
    api.setSummaryPrompt(async () => '');
    try {
      git('rev-parse', '--verify', 'HEAD');
    } catch {
      git('add', 'sample.ts');
      git('commit', '-qm', 'first commit', '--', 'sample.ts');
    }
    home = git('symbolic-ref', '--short', 'HEAD');
  });

  beforeEach(async () => {
    rmSync(join(ws, '.local-review'), { recursive: true, force: true });
    await checkout(home);
    await api.reload();
  });

  after(async () => {
    await checkout(home);
    api.setSummaryPrompt(undefined);
  });

  it('records the branch of a new thread', async () => {
    const id = await comment('On this branch', 1);
    assert.equal((await stateOf(id))?.branch?.branch, home);
  });

  it('shows a thread on its branch only', async () => {
    const id = await comment('Only here', 1);
    await checkout('-b', 'other-1');
    assert.equal(shown(id), false);
    assert.equal(hidden(id), true);
    await checkout(home);
    assert.equal(shown(id), true);
    assert.equal(api.listThreads().find((t) => t.id === id)!.thread.range!.start.line, 1);
    git('branch', '-D', 'other-1');
  });

  it('has one review per branch, submitted apart', async () => {
    await comment('Draft here', 1, 'localReview.addToReview');
    await checkout('-b', 'other-2');
    await comment('Draft there', 3, 'localReview.addToReview');
    const reviews = api.reviewsInProgress();
    assert.equal(reviews.length, 2);
    assert.deepEqual(
      reviews.map((r) => r.drafts),
      [1, 1],
    );

    await vscode.window.showTextDocument(uri); // the review of the active editor's branch
    assert.equal(await vscode.commands.executeCommand<number>('localReview.submitReview'), 1);
    assert.deepEqual(
      api.reviewsInProgress().map((r) => r.review.branch?.branch),
      [home],
    );
    await checkout(home);
    git('branch', '-D', 'other-2');
  });

  it('offers drafts first only where a review is in progress: on the branch of the file shown', async () => {
    const waitHere = async (expected: boolean) => {
      for (let i = 0; i < 80 && api.reviewContext().here !== expected; i++) await new Promise((r) => setTimeout(r, 25));
      return api.reviewContext();
    };
    await vscode.window.showTextDocument(uri);
    assert.deepEqual(await waitHere(false), { active: false, here: false });
    await comment('Draft here', 1, 'localReview.addToReview');
    assert.deepEqual(await waitHere(true), { active: true, here: true });

    await checkout('-b', 'other-4'); // the review stays on the home branch
    assert.deepEqual(await waitHere(false), { active: true, here: false });
    await checkout(home);
    assert.deepEqual(await waitHere(true), { active: true, here: true });
    git('branch', '-D', 'other-4');
  });

  it('follows a renamed branch, and deletes the threads and review of a deleted one', async () => {
    await checkout('-b', 'to-rename');
    const kept = await comment('Survives the rename', 1);
    await checkout(home);
    git('branch', '-m', 'to-rename', 'renamed');
    await api.refreshBranches();
    assert.equal((await stateOf(kept))?.branch?.branch, 'renamed');

    await checkout('-b', 'to-delete');
    const gone = await comment('Goes with its branch', 1);
    await comment('A draft too', 3, 'localReview.addToReview');
    await checkout(home);
    git('branch', '-D', 'to-delete');
    await api.refreshBranches();
    assert.equal((await stateOf(gone))?.deleted, true);
    assert.equal(hidden(gone), false);
    assert.deepEqual(
      api.reviewsInProgress().filter((r) => r.review.branch?.branch === 'to-delete'),
      [],
    );
    git('branch', '-D', 'renamed');
  });

  it('keeps showing threads of files ignored by git, which do not change with the branch', async () => {
    writeFileSync(join(ws, '.git', 'info', 'exclude'), '.local-review/\nnotes.md\n');
    writeFileSync(join(ws, 'notes.md'), 'my notes\nsecond line\n');
    const notes = vscode.Uri.file(join(ws, 'notes.md'));
    await vscode.workspace.openTextDocument(notes);
    const id = await comment('A note', 0, 'localReview.submitComment', notes);
    assert.equal((await stateOf(id))?.branch, null);
    await checkout('-b', 'other-3');
    assert.equal(shown(id), true);
    await checkout(home);
    git('branch', '-D', 'other-3');
  });

  it('gives threads made before branches the branch checked out now', async () => {
    const store = new Store(ws);
    const text = (await vscode.workspace.openTextDocument(uri)).getText();
    const legacy = await store.createThread(
      {
        path: 'sample.ts',
        source: 'worktree',
        ref: null,
        sha: null,
        ...buildAnchorContext(text, { startLine: 2, endLine: 2 }),
      },
      { author: 'user', body: 'Old thread', reviewId: null },
    );
    assert.equal(legacy.branch, null);
    await api.reload();
    assert.equal((await stateOf(legacy.id))?.branch?.branch, home);
  });
});

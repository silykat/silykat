import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { LocalReviewApi } from '../../src/extension';
import { WAIT_MS } from './timing';

const EXTENSION_ID = 'local.local-review';
const ORIGINAL = Array.from({ length: 10 }, (_, i) => `const v${i + 1} = ${i + 1};`);

interface GitApi {
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
  repositories: { status(): Promise<void> }[];
}

async function waitFor<T>(what: string, probe: () => T | undefined, timeoutMs = WAIT_MS): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('Comment in the diff of changes (Source Control)', () => {
  let api: LocalReviewApi;
  let gitApi: GitApi;
  let ws: string;
  let n = 0;

  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
      cwd: ws,
      encoding: 'utf8',
    }).trim();
  const managed = (id: string) => api.listThreads().find((t) => t.id === id)!;

  /** A committed file, then modified in the working tree: line 5 changed, line 8 deleted. */
  async function changedFile(): Promise<vscode.Uri> {
    const path = join(ws, `diff-${++n}.ts`);
    writeFileSync(path, ORIGINAL.join('\n') + '\n');
    git('add', path);
    git('commit', '-q', '-m', `fixture ${n}`, '--', path);
    const changed = [...ORIGINAL];
    changed[4] = 'const v5 = 500;';
    changed.splice(7, 1);
    writeFileSync(path, changed.join('\n') + '\n');
    await gitApi.repositories[0]!.status();
    return vscode.Uri.file(path);
  }

  /** Opens the diff the Source Control view opens for a changed file ("Changes": index ↔ working tree). */
  async function openChanges(file: vscode.Uri): Promise<vscode.TabInputTextDiff> {
    await vscode.commands.executeCommand('git.openChange', file);
    return waitFor('the diff tab', () => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return input instanceof vscode.TabInputTextDiff && input.modified.fsPath === file.fsPath ? input : undefined;
    });
  }

  /** Opens the diff of "Staged Changes" (HEAD ↔ index), built like the git extension does. */
  async function openStaged(file: vscode.Uri): Promise<vscode.TabInputTextDiff> {
    git('add', file.fsPath);
    await gitApi.repositories[0]!.status();
    const left = gitApi.toGitUri(file, 'HEAD');
    const right = gitApi.toGitUri(file, '');
    await vscode.commands.executeCommand('vscode.diff', left, right, 'staged');
    return waitFor('the staged diff tab', () => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return input instanceof vscode.TabInputTextDiff && input.original.toString() === left.toString()
        ? input
        : undefined;
    });
  }

  async function commentOn(uri: vscode.Uri, line: number, text: string, command = 'localReview.submitComment') {
    await vscode.workspace.openTextDocument(uri); // what the diff editor has done already
    const known = new Set(api.listThreads().map((t) => t.id));
    const thread = api.controller.createCommentThread(uri, new vscode.Range(line, 0, line, 0), []);
    await vscode.commands.executeCommand(command, { thread, text });
    return api.listThreads().find((t) => !known.has(t.id))!.id;
  }

  before(async () => {
    const ext = vscode.extensions.getExtension<LocalReviewApi>(EXTENSION_ID)!;
    api = await ext.activate();
    ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    const gitExt = vscode.extensions.getExtension<{ getAPI(v: 1): GitApi }>('vscode.git')!;
    gitApi = (await gitExt.activate()).getAPI(1);
    await waitFor('the git repository', () => (gitApi.repositories.length > 0 ? true : undefined), 10000);
  });

  beforeEach(async () => {
    rmSync(join(ws, '.local-review'), { recursive: true, force: true });
    await api.reload();
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('comments the new code (right side): a working tree thread, also shown on the file', async () => {
    const file = await changedFile();
    const diff = await openChanges(file);
    const id = await commentOn(diff.modified, 4, 'Why 500?');

    const t = managed(id);
    assert.equal(t.state.anchor.source, 'worktree');
    assert.equal(t.state.anchor.snippet, 'const v5 = 500;');
    const rel = file.path.split('/').pop();
    assert.deepEqual(t.state.anchor.diff, {
      side: 'head',
      base: { source: 'git', ref: '~', sha: null, path: rel },
      head: { source: 'worktree', ref: null, sha: null, path: rel },
    });
    assert.equal(t.uris[0], file.toString(), 'the thread lives on the file itself');
    assert.equal(t.thread.label, 'Waiting for Claude');
  });

  it('comments the old code (left side), even a deleted line, and keeps it on that side', async () => {
    const file = await changedFile();
    const diff = await openChanges(file);
    const onOld = await commentOn(diff.original, 4, 'The old value was fine');
    const onDeleted = await commentOn(diff.original, 7, 'Why delete this?');

    const t = managed(onOld);
    assert.equal(t.state.anchor.source, 'git');
    assert.equal(t.state.anchor.ref, '~');
    assert.equal(t.state.anchor.sha, null);
    assert.equal(t.state.anchor.snippet, 'const v5 = 5;');
    assert.equal(t.state.anchor.diff?.side, 'base');
    assert.equal(managed(onDeleted).state.anchor.snippet, 'const v8 = 8;', 'the deleted code is kept');
    assert.equal(t.uris[0], diff.original.toString(), 'shown on the left side of this diff');
    assert.equal(t.thread.label, 'Index · Waiting for Claude');

    // Reopening the same diff later, e.g. after a restart
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await api.reload();
    const again = await openChanges(file);
    assert.ok(managed(onOld).uris.includes(again.original.toString()));
    assert.deepEqual(managed(onOld).thread.range && [managed(onOld).thread.range!.start.line], [4]);
  });

  it('comments both sides of the staged changes', async () => {
    const file = await changedFile();
    const diff = await openStaged(file);
    const head = git('rev-parse', 'HEAD');

    const onHead = await commentOn(diff.original, 4, 'Before');
    const onIndex = await commentOn(diff.modified, 4, 'After');

    const h = managed(onHead);
    assert.equal(h.state.anchor.ref, 'HEAD');
    assert.equal(h.state.anchor.sha, head, 'pinned to the commit HEAD was');
    assert.equal(h.state.anchor.snippet, 'const v5 = 5;');
    assert.equal(h.thread.label, `HEAD ${head.slice(0, 7)} · Waiting for Claude`);
    assert.ok(h.uris.includes(diff.original.toString()), 'shown on the HEAD side');
    assert.ok(h.uris[0]!.includes(head), 'its canonical URI is the exact commit');

    const i = managed(onIndex);
    assert.equal(i.state.anchor.ref, '~');
    assert.equal(i.state.anchor.snippet, 'const v5 = 500;');
    assert.ok(i.uris.includes(diff.modified.toString()), 'shown on the index side');
    git('reset', '-q', '--', file.fsPath);
  });

  it('stays on the commit it was made on once HEAD moves', async () => {
    const file = await changedFile();
    const diff = await openStaged(file);
    const id = await commentOn(diff.original, 4, 'Before');
    const before = managed(id).state.anchor.sha;
    git('commit', '-q', '-m', 'move HEAD', '--', file.fsPath);
    await gitApi.repositories[0]!.status();

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const newHead = gitApi.toGitUri(file, 'HEAD');
    const doc = await vscode.workspace.openTextDocument(newHead);
    await vscode.window.showTextDocument(doc);
    await waitFor('the new HEAD content', () => (doc.getText().includes('const v5 = 500;') ? true : undefined));
    await waitFor('the thread to leave the new HEAD', () =>
      managed(id).uris.includes(newHead.toString()) ? undefined : true,
    );
    assert.equal(managed(id).state.anchor.sha, before);
  });

  it('works in review mode and with the agent', async () => {
    const file = await changedFile();
    const diff = await openChanges(file);
    const id = await commentOn(diff.original, 2, 'Draft on the old code', 'localReview.startReview');
    assert.equal(managed(id).state.comments[0]!.isDraft, true);
    assert.equal(managed(id).thread.label, 'Index · Pending');
    api.setSummaryPrompt(async () => '');
    await vscode.commands.executeCommand('localReview.submitReview');
    api.setSummaryPrompt(undefined);

    await vscode.commands.executeCommand('localReview.dev.simulateAgentReply', {
      threadId: id,
      body: 'Why?',
      status: 'needs-info',
    });
    await waitFor('the agent reply', () => (managed(id).state.comments.length === 2 ? true : undefined));
    assert.equal(managed(id).thread.label, 'Index · ❓ Claude is waiting for your reply');
  });
});

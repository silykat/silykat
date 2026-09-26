import * as assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { LocalReviewApi } from '../../src/extension';

const EXTENSION_ID = 'local.local-review';

async function waitFor<T>(what: string, probe: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('Replies written by agents with the lr CLI', () => {
  let api: LocalReviewApi;
  let ws: string;
  let uri: vscode.Uri;
  let lrScript: string;

  /** Runs the real, bundled `lr` in its own process, as an agent does. */
  const lr = (...args: string[]) =>
    new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const child = fork(lrScript, args, { cwd: ws, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      let stdout = '';
      child.stdout!.on('data', (c: Buffer) => (stdout += c.toString()));
      child.on('exit', (code) => resolve({ code, stdout }));
    });

  before(async () => {
    const ext = vscode.extensions.getExtension<LocalReviewApi>(EXTENSION_ID)!;
    api = await ext.activate();
    ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    uri = vscode.Uri.file(join(ws, 'sample.ts'));
    lrScript = join(ext.extensionPath, '..', 'cli', 'dist', 'lr.js');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  });

  beforeEach(async () => {
    rmSync(join(ws, '.local-review'), { recursive: true, force: true });
    await api.reload();
  });

  it('lists what the user wrote, and shows the reply live, signed by the agent', async () => {
    const thread = api.controller.createCommentThread(uri, new vscode.Range(4, 0, 4, 0), []);
    await vscode.commands.executeCommand('localReview.submitComment', { thread, text: 'Rename line5' });
    const id = api.listThreads().find((t) => t.thread === thread)!.id;

    const listed = await lr('list');
    assert.equal(listed.code, 0);
    assert.ok(listed.stdout.includes(`## ${id} — sample.ts:5`), listed.stdout);
    assert.ok(listed.stdout.includes('Rename line5'));

    const replied = await lr(
      'reply',
      id,
      '--agent',
      'Claude',
      '--status',
      'needs-info',
      '--body',
      'Rename it to what?',
    );
    assert.equal(replied.code, 0);
    const t = await waitFor('the reply in VS Code', () => {
      const m = api.listThreads().find((x) => x.id === id);
      return m && m.thread.comments.length === 2 ? m : undefined;
    });
    assert.equal(t.thread.comments[1]!.author.name, 'Claude');
    assert.equal(t.thread.label, '❓ Claude is waiting for your reply');
  });

  it('does not show drafts to the agent', async () => {
    await vscode.commands.executeCommand('localReview.startReview');
    const thread = api.controller.createCommentThread(uri, new vscode.Range(6, 0, 6, 0), []);
    await vscode.commands.executeCommand('localReview.addToReview', { thread, text: 'Secret draft' });
    const listed = await lr('list', '--all');
    assert.ok(!listed.stdout.includes('Secret draft'), listed.stdout);
  });
});

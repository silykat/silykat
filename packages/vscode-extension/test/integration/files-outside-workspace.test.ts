import * as assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { silykatHome, looseStore, SessionRegistry, type Delivery } from '@silykat/core';
import type { SilykatApi } from '../../src/extension';

const EXTENSION_ID = 'silykat.silykat';

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 4000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('Comments on files outside the open folders', () => {
  let api: SilykatApi;
  let outside: string; // a folder in none of the workspace folders
  let file: string;
  let uri: vscode.Uri;
  let registry: SessionRegistry;

  const byFile = () => api.listThreads().find((t) => t.thread.uri.fsPath === file);
  const ranges = async (target: vscode.Uri) => {
    const doc = await vscode.workspace.openTextDocument(target);
    const provided = await api.controller.commentingRangeProvider!.provideCommentingRanges(
      doc,
      new vscode.CancellationTokenSource().token,
    );
    return Array.isArray(provided) ? provided : (provided?.ranges ?? []);
  };

  before(async () => {
    const ext = vscode.extensions.getExtension<SilykatApi>(EXTENSION_ID)!;
    api = await ext.activate();
    registry = new SessionRegistry(silykatHome());
    outside = mkdtempSync(join(tmpdir(), 'slk-outside-'));
    file = join(outside, 'spec.md');
    writeFileSync(file, '# Spec\n\nFirst point\nSecond point\n');
    uri = vscode.Uri.file(file);
  });

  beforeEach(async () => {
    rmSync(looseStore().dir, { recursive: true, force: true });
    rmSync(registry.dir, { recursive: true, force: true });
    await api.reload();
  });

  after(() => {
    rmSync(looseStore().dir, { recursive: true, force: true });
    rmSync(registry.dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('can be commented, and are kept in the machine store with their full path', async () => {
    assert.equal(vscode.workspace.getWorkspaceFolder(uri), undefined, 'outside the workspace');
    assert.ok((await ranges(uri)).length > 0, 'commentable');
    await vscode.window.showTextDocument(uri);
    const thread = api.controller.createCommentThread(uri, new vscode.Range(2, 0, 2, 0), []);
    await vscode.commands.executeCommand('silykat.submitComment', { thread, text: 'Clarify this point' });

    const { threads } = await looseStore().loadAll();
    assert.equal(threads.length, 1);
    assert.equal(threads[0]!.anchor.path, file.slice(1)); // relative to "/": the full path
    assert.equal(threads[0]!.branch, null); // outside git

    await api.reload(); // e.g. the next time VS Code starts
    assert.equal(byFile()?.thread.range?.start.line, 2);
  });

  it('shows the agent replies live', async () => {
    const thread = api.controller.createCommentThread(uri, new vscode.Range(3, 0, 3, 0), []);
    await vscode.commands.executeCommand('silykat.submitComment', { thread, text: 'And this one?' });
    const id = byFile()!.id;
    await looseStore().addComment(
      id,
      { author: 'agent', agent: 'Claude', body: 'Done', reviewId: null },
      { status: 'addressed' },
    );
    await waitFor('the agent reply', () => (byFile()!.thread.comments.length === 2 ? true : undefined));
    assert.equal(byFile()!.state.status, 'addressed');
  });

  it('goes to the session subscribed to the file, with the root of the machine store', async () => {
    await registry.register({
      id: 'writer',
      agent: 'Claude',
      cwd: '/somewhere',
      branch: null,
      pid: process.pid, // alive for as long as the test runs
      startedAt: new Date().toISOString(),
      push: true,
    });
    await registry.subscribe('writer', { kind: 'path', path: file }, 'modified');
    const thread = api.controller.createCommentThread(uri, new vscode.Range(2, 0, 2, 0), []);
    await vscode.commands.executeCommand('silykat.submitComment', { thread, text: 'For the writer' });
    const [d] = await waitFor('the delivery', async () => {
      const deliveries: Delivery[] = (await registry.readInbox('writer')).deliveries;
      return deliveries.length > 0 ? deliveries : undefined;
    });
    assert.equal(d!.root, '/');
  });

  it("never offers to comment silykat's own machine folder", async () => {
    const own = join(silykatHome(), 'sessions');
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, 'x.json'), '{}\n');
    assert.deepEqual(await ranges(vscode.Uri.file(join(own, 'x.json'))), []);
  });
});

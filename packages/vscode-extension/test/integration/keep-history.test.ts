import * as assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { readConfig, RetroBook } from '@local-review/core';
import type { LocalReviewApi } from '../../src/extension';
import { WAIT_MS } from './timing';

const EXTENSION_ID = 'local.local-review';

async function until(what: string, probe: () => Promise<boolean> | boolean, timeoutMs = WAIT_MS): Promise<void> {
  const start = Date.now();
  while (!(await probe())) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('Keeping the history of what is deleted', () => {
  let api: LocalReviewApi;
  let ws: string;
  let uri: vscode.Uri;
  let confirmed: { message: string; detail: string; action: string }[];
  let informed: string[];
  let offers: string[];
  let eraseAnswer: string | undefined;

  const settings = () => vscode.workspace.getConfiguration('localReview');
  const journal = (id: string) => join(ws, '.local-review', 'threads', `${id}.jsonl`);
  const managed = (id: string) => api.listThreads().find((t) => t.id === id)!;
  const tomorrow = () => {
    const d = new Date(Date.now() + 86_400_000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  async function newThread(line: number, text = 'Rename this variable'): Promise<string> {
    const thread = api.controller.createCommentThread(uri, new vscode.Range(line, 0, line, 0), []);
    await vscode.commands.executeCommand('localReview.submitComment', { thread, text });
    return api.listThreads().find((t) => t.thread === thread)!.id;
  }
  const deleteThread = (id: string) => vscode.commands.executeCommand('localReview.deleteThread', managed(id).thread);

  before(async () => {
    const ext = vscode.extensions.getExtension<LocalReviewApi>(EXTENSION_ID)!;
    api = await ext.activate();
    ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    uri = vscode.Uri.file(join(ws, 'sample.ts'));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  });

  beforeEach(async () => {
    confirmed = [];
    informed = [];
    offers = [];
    eraseAnswer = 'Erase';
    rmSync(join(ws, '.local-review'), { recursive: true, force: true });
    await api.reload();
    api.setConfirmHandler(async (message, detail, action) => {
      confirmed.push({ message, detail, action });
      return true;
    });
    api.setArchivePrompts({ askDate: async () => tomorrow(), inform: (m) => informed.push(m) });
    api.setErasePrompt(async (message) => {
      offers.push(message);
      return eraseAnswer;
    });
  });

  afterEach(async () => {
    await settings().update('keepHistory', undefined, vscode.ConfigurationTarget.Global);
    await until('the machine setting back to on', async () => (await readConfig()).keepHistory);
  });

  after(async () => {
    api.setConfirmHandler(undefined);
    api.setArchivePrompts(undefined);
    api.setErasePrompt(undefined);
    rmSync(join(ws, '.local-review'), { recursive: true, force: true });
    await api.reload();
  });

  it('keeps a deleted thread on disk by default', async () => {
    const id = await newThread(2);
    await deleteThread(id);
    assert.match(confirmed[0]!.detail, /will no longer be shown\.$/);
    assert.ok(existsSync(journal(id)));
  });

  it('when turned off: tells the machine, offers to erase the history kept, then erases what is deleted', async () => {
    const before = await newThread(2);
    await deleteThread(before);
    assert.ok(existsSync(journal(before)));

    await settings().update('keepHistory', false, vscode.ConfigurationTarget.Global);
    await until('the machine setting to be off', async () => !(await readConfig()).keepHistory);
    await until('the offer to erase the history kept', () => offers.length === 1);
    assert.match(offers[0]!, /The history already kept in your folders stays: 1 deleted thread\. Erase it for good\?/);
    assert.equal(await api.lastEraseOffer(), 1);
    assert.equal(existsSync(journal(before)), false);

    const id = await newThread(4);
    await deleteThread(id);
    assert.match(confirmed.at(-1)!.detail, /will be erased for good \(history not kept\)\.$/);
    assert.equal(existsSync(journal(id)), false);
    assert.deepEqual(api.listThreads(), []);

    // Deleting the only comment of a thread deletes the thread: erased too.
    const last = await newThread(6);
    const comment = managed(last).thread.comments[0]!;
    await vscode.commands.executeCommand('localReview.deleteComment', comment);
    assert.equal(existsSync(journal(last)), false);
  });

  it('keeps the history already kept when the user says so', async () => {
    const id = await newThread(2);
    await deleteThread(id);
    eraseAnswer = 'Keep';
    await settings().update('keepHistory', false, vscode.ConfigurationTarget.Global);
    await until('the offer to erase the history kept', () => offers.length === 1);
    assert.equal(await api.lastEraseOffer(), undefined);
    assert.ok(existsSync(journal(id)));
  });

  it('keeps the old threads a retro has not read yet, when deleting old threads', async () => {
    const read = await newThread(2);
    await vscode.commands.executeCommand('localReview.resolveThread', managed(read).thread);
    const book = new RetroBook(ws);
    const retro = await book.start({
      root: ws,
      since: null,
      until: new Date(Date.now() + 10).toISOString(),
      stores: [],
      threads: [read],
      bytes: 1,
    });
    await book.record(retro.id, [{ type: 'retro.finished' }]);
    await new Promise((r) => setTimeout(r, 20));
    const unread = await newThread(4);
    await vscode.commands.executeCommand('localReview.resolveThread', managed(unread).thread);

    await vscode.commands.executeCommand('localReview.deleteOldThreads');
    assert.equal(confirmed[0]?.message, 'Delete 1 thread permanently?');
    assert.match(confirmed[0]!.detail, /with no activity since \d{4}-\d{2}-\d{2}, /);
    assert.match(confirmed[0]!.detail, /1 finished thread not read by a retro yet is kept for the next one\./);
    assert.equal(existsSync(journal(read)), false);
    assert.ok(existsSync(journal(unread)));
  });
});

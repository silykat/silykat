import * as assert from 'node:assert/strict';
import { appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { SilykatApi } from '../../src/extension';
import { WAIT_MS } from './timing';

const EXTENSION_ID = 'silykat.silykat';

describe('Comments written by a newer version of silykat', () => {
  let api: SilykatApi;
  let ws: string;
  let uri: vscode.Uri;
  let shown: string[];

  async function newThread(line: number): Promise<string> {
    const thread = api.controller.createCommentThread(uri, new vscode.Range(line, 0, line, 0), []);
    await vscode.commands.executeCommand('silykat.submitComment', { thread, text: 'Rename this variable' });
    return api.listThreads().find((t) => t.thread === thread)!.id;
  }
  /** An event of a future format, as a newer version would write it. */
  const fromTheFuture = (id: string) =>
    appendFileSync(join(ws, '.silykat', 'threads', `${id}.jsonl`), '{"v":99,"type":"comment.added"}\n');
  const warnings = () => shown.filter((m) => m.includes('newer version of silykat'));

  before(async () => {
    const ext = vscode.extensions.getExtension<SilykatApi>(EXTENSION_ID)!;
    api = await ext.activate();
    ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    uri = vscode.Uri.file(join(ws, 'sample.ts'));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    api.setChooseHandler(async (message) => {
      shown.push(message);
      return undefined;
    });
  });

  beforeEach(async () => {
    shown = [];
    rmSync(join(ws, '.silykat'), { recursive: true, force: true });
    await api.reload();
  });

  after(async () => {
    api.setChooseHandler(undefined);
    rmSync(join(ws, '.silykat'), { recursive: true, force: true });
    await api.reload();
  });

  it('says to update the extension, once per folder, and keeps those comments read-only', async () => {
    const a = await newThread(2);
    const b = await newThread(4);
    fromTheFuture(a);
    fromTheFuture(b);
    for (let i = 0; i < WAIT_MS / 25 && warnings().length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    await api.reload(); // both threads again: still one message
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(warnings().length, 1);
    assert.match(warnings()[0]!, /Update the extension/);
    const thread = api.listThreads().find((t) => t.id === a)!;
    assert.equal(thread.state.readOnly, true);
    assert.equal(thread.thread.canReply, false);
  });
});

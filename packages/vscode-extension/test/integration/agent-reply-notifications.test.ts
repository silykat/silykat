import * as assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { SilykatApi } from '../../src/extension';
import { WAIT_MS } from './timing';

const EXTENSION_ID = 'silykat.silykat';

async function waitFor<T>(what: string, probe: () => T | undefined, timeoutMs = WAIT_MS): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Know when the agent replied', () => {
  let api: SilykatApi;
  let ws: string;
  let uri: vscode.Uri;
  let extensionPath: string;
  let notifications: string[];
  let clickAction: boolean;

  const managed = (id: string) => api.listThreads().find((t) => t.id === id)!;

  async function newThread(line: number): Promise<string> {
    const thread = api.controller.createCommentThread(uri, new vscode.Range(line, 0, line, 0), []);
    await vscode.commands.executeCommand('silykat.submitComment', { thread, text: 'Why?' });
    return api.listThreads().find((t) => t.thread === thread)!.id;
  }

  /** The agent replies from its own process, like a real integration. */
  const agentReplies = (threadId: string, body = 'Because.') =>
    new Promise<number | null>((resolve) =>
      fork(
        join(extensionPath, 'dist', 'fake-agent.js'),
        ['--root', ws, '--thread', threadId, '--body', body, '--status', 'needs-info'],
        {
          stdio: 'ignore',
        },
      ).on('exit', resolve),
    );

  before(async () => {
    const ext = vscode.extensions.getExtension<SilykatApi>(EXTENSION_ID)!;
    api = await ext.activate();
    extensionPath = ext.extensionPath;
    ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    uri = vscode.Uri.file(join(ws, 'sample.ts'));
  });

  beforeEach(async () => {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    rmSync(join(ws, '.silykat'), { recursive: true, force: true });
    await api.reload();
    notifications = [];
    clickAction = false;
    api.setNotifier(async (message) => {
      notifications.push(message);
      return clickAction;
    });
  });

  after(() => api.setNotifier(undefined));

  it('notifies when the agent replies, with where', async () => {
    const id = await newThread(11);
    await agentReplies(id);
    await waitFor('the notification', () => (notifications.length === 1 ? true : undefined));
    assert.deepEqual(notifications, ['silykat: Claude replied on sample.ts:12']);
    assert.equal(managed(id).state.lastAuthor, 'agent');
  });

  it('opens the thread from the notification', async () => {
    const id = await newThread(15);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    clickAction = true;
    await agentReplies(id);
    // Revealing opens the file first, then moves the cursor to the thread: wait for both.
    const editor = await waitFor('the thread to be revealed', () => {
      const e = vscode.window.activeTextEditor;
      return e?.document.uri.fsPath === uri.fsPath && e.selection.active.line === 15 ? e : undefined;
    });
    assert.equal(editor.selection.active.line, 15);
  });

  it('counts the threads waiting for my reply in the status bar', async () => {
    assert.equal(api.awaitingStatusText(), undefined, 'hidden when nothing waits');
    const a = await newThread(2);
    const b = await newThread(4);
    await agentReplies(a);
    await waitFor('one waiting', () => (api.awaitingStatusText() === '$(comment-unresolved) 1' ? true : undefined));
    await agentReplies(b);
    await waitFor('two waiting', () => (api.awaitingStatusText() === '$(comment-unresolved) 2' ? true : undefined));
    assert.deepEqual(
      api
        .awaitingUser()
        .map((t) => t.id)
        .sort(),
      [a, b].sort(),
    );
  });

  it('counts down when I reply or resolve', async () => {
    const a = await newThread(2);
    const b = await newThread(4);
    await Promise.all([agentReplies(a), agentReplies(b)]);
    await waitFor('two waiting', () => (api.awaitingUser().length === 2 ? true : undefined));

    await vscode.commands.executeCommand('silykat.reply', { thread: managed(a).thread, text: 'Here is why' });
    assert.equal(api.awaitingStatusText(), '$(comment-unresolved) 1');
    await vscode.commands.executeCommand('silykat.resolveThread', managed(b).thread);
    assert.equal(api.awaitingStatusText(), undefined);
  });

  it('groups replies arriving together into one notification', async () => {
    const ids = [await newThread(2), await newThread(4), await newThread(6)];
    await Promise.all(ids.map((id) => agentReplies(id)));
    await waitFor('the notification', () => (notifications.length > 0 ? true : undefined));
    await sleep(800); // no second notification comes
    assert.deepEqual(notifications, ['silykat: Claude replied on 3 threads']);
  });

  it('can be turned off in the settings; the counter stays', async () => {
    const config = vscode.workspace.getConfiguration('silykat');
    await config.update('notifyOnAgentReply', false, vscode.ConfigurationTarget.Global);
    try {
      const id = await newThread(8);
      await agentReplies(id);
      await waitFor('the counter', () => (api.awaitingStatusText() ? true : undefined));
      await sleep(800);
      assert.deepEqual(notifications, []);
    } finally {
      await config.update('notifyOnAgentReply', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  it('does not announce a reply I already answered meanwhile', async () => {
    const id = await newThread(10);
    const reply = agentReplies(id);
    await reply;
    await waitFor('the agent reply', () => (managed(id).state.lastAuthor === 'agent' ? true : undefined));
    await vscode.commands.executeCommand('silykat.reply', { thread: managed(id).thread, text: 'Already on it' });
    await sleep(800);
    assert.deepEqual(notifications, []);
  });

  it('does not notify again for replies already there at startup', async () => {
    const id = await newThread(9);
    await agentReplies(id);
    await waitFor('the notification', () => (notifications.length === 1 ? true : undefined));
    await api.reload();
    await sleep(800);
    assert.equal(notifications.length, 1);
    assert.equal(api.awaitingStatusText(), '$(comment-unresolved) 1', 'but still counted');
  });
});

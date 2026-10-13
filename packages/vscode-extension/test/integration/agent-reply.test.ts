import * as assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { SilykatApi } from '../../src/extension';
import { WAIT_MS } from './timing';

const EXTENSION_ID = 'silykat.silykat';
const LIVE_DEADLINE_MS = 1000; // "in less than a second"

async function waitFor<T>(what: string, probe: () => T | undefined, timeoutMs: number): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('See the agent’s reply appear in the thread (default agent: Claude)', () => {
  let api: SilykatApi;
  let ws: string;
  let uri: vscode.Uri;
  let extensionPath: string;

  const threadById = (id: string) => api.listThreads().find((t) => t.id === id);

  async function newThread(line: number, text = 'Why return null here?'): Promise<string> {
    const thread = api.controller.createCommentThread(uri, new vscode.Range(line, 0, line, 0), []);
    await vscode.commands.executeCommand('silykat.submitComment', { thread, text });
    const managed = api.listThreads().find((t) => t.thread === thread);
    assert.ok(managed, 'thread was not created');
    return managed.id;
  }

  async function simulate(threadId: string, body: string, status: 'needs-info' | 'addressed' | 'none', agent?: string) {
    const ok = await vscode.commands.executeCommand<boolean>('silykat.dev.simulateAgentReply', {
      threadId,
      body,
      status,
      agent,
    });
    assert.equal(ok, true, 'simulated reply failed');
  }

  before(async () => {
    const ext = vscode.extensions.getExtension<SilykatApi>(EXTENSION_ID);
    assert.ok(ext);
    api = await ext.activate();
    extensionPath = ext.extensionPath;
    ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    uri = vscode.Uri.file(join(ws, 'sample.ts'));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  });

  beforeEach(async () => {
    rmSync(join(ws, '.silykat'), { recursive: true, force: true });
    await api.reload();
  });

  it('shows a thread without Claude reply as "Waiting for Claude"', async () => {
    const id = await newThread(4);
    assert.equal(threadById(id)!.thread.label, 'Waiting for Claude');
  });

  it('shows a question from Claude live, as Claude, and expands the thread', async () => {
    const id = await newThread(5);
    threadById(id)!.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;

    const sent = Date.now();
    await simulate(id, 'Why this choice?', 'needs-info');
    const thread = await waitFor(
      'the Claude reply',
      () => {
        const t = threadById(id);
        return t && t.thread.comments.length === 2 ? t.thread : undefined;
      },
      LIVE_DEADLINE_MS,
    );
    const elapsed = Date.now() - sent;

    const reply = thread.comments[1]!;
    assert.equal(reply.author.name, 'Claude');
    assert.ok(reply.author.iconPath, 'Claude has an icon');
    assert.equal(thread.comments[0]!.author.iconPath, undefined, 'the user has no Claude icon');
    assert.equal((reply.body as vscode.MarkdownString).value, 'Why this choice?');
    assert.equal(thread.label, '❓ Claude is waiting for your reply');
    assert.equal(thread.collapsibleState, vscode.CommentThreadCollapsibleState.Expanded);
    assert.ok(elapsed < LIVE_DEADLINE_MS, `reply took ${elapsed} ms`);
  });

  it('labels an addressed thread', async () => {
    const id = await newThread(6);
    await simulate(id, 'Done: it now throws `NotFoundError`.', 'addressed');
    await waitFor(
      'the addressed label',
      () => (threadById(id)?.thread.label?.startsWith('✅') ? true : undefined),
      WAIT_MS,
    );
    assert.equal(threadById(id)!.thread.label, '✅ Addressed by Claude — please verify');
  });

  it('labels a reply without status change', async () => {
    const id = await newThread(7);
    await simulate(id, 'Noted.', 'none');
    await waitFor('the reply', () => (threadById(id)?.thread.comments.length === 2 ? true : undefined), WAIT_MS);
    assert.equal(threadById(id)!.thread.label, '💬 Claude replied');
  });

  it('renders Claude’s markdown as untrusted', async () => {
    const id = await newThread(8);
    await simulate(id, '`code` and a [link](command:workbench.action.quit)', 'none');
    const thread = await waitFor(
      'the reply',
      () => (threadById(id)?.thread.comments.length === 2 ? threadById(id)!.thread : undefined),
      WAIT_MS,
    );
    const body = thread.comments[1]!.body as vscode.MarkdownString;
    assert.equal(body.isTrusted, false);
    assert.equal(body.supportHtml, false);
  });

  it('keeps the reply and the status after a reload', async () => {
    const id = await newThread(9);
    await simulate(id, 'Why this choice?', 'needs-info');
    await waitFor('the reply', () => (threadById(id)?.thread.comments.length === 2 ? true : undefined), WAIT_MS);
    await api.reload();
    const t = threadById(id)!;
    assert.deepEqual(
      t.state.comments.map((c) => c.author),
      ['user', 'agent'],
    );
    assert.equal(t.thread.label, '❓ Claude is waiting for your reply');
  });

  it('shows the name of whichever agent replied (LLM-agnostic)', async () => {
    const id = await newThread(10);
    await simulate(id, 'Which error type?', 'needs-info', 'Codex');
    const thread = await waitFor(
      'the Codex reply',
      () => (threadById(id)?.thread.comments.length === 2 ? threadById(id)!.thread : undefined),
      WAIT_MS,
    );
    assert.equal(thread.comments[1]!.author.name, 'Codex');
    assert.equal(thread.label, '❓ Codex is waiting for your reply');
    assert.deepEqual(
      threadById(id)!.state.comments.map((c) => c.author),
      ['user', 'agent'],
    );
  });

  it('reports a failure of the external process', async () => {
    const script = join(extensionPath, 'dist', 'fake-agent.js');
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = fork(script, ['--root', ws, '--thread', 't_00000000000000000000000000', '--body', 'x'], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      let stderr = '';
      child.stderr!.on('data', (c: Buffer) => (stderr += c.toString()));
      child.on('exit', (code) => resolve({ code, stderr }));
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Thread not found/);
  });
});

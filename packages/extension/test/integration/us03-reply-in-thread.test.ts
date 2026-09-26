import * as assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { LocalReviewApi } from '../../src/extension';

const EXTENSION_ID = 'local.local-review';

async function waitFor<T>(what: string, probe: () => T | undefined, timeoutMs = 1500): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('US-03 — reply to the agent in the thread', () => {
  let api: LocalReviewApi;
  let ws: string;
  let uri: vscode.Uri;
  let extensionPath: string;

  const managed = (id: string) => api.listThreads().find((t) => t.id === id)!;
  const journal = (id: string) =>
    readFileSync(join(ws, '.local-review', 'threads', `${id}.jsonl`), 'utf8')
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l));

  async function newThread(line: number): Promise<string> {
    const thread = api.controller.createCommentThread(uri, new vscode.Range(line, 0, line, 0), []);
    await vscode.commands.executeCommand('localReview.submitComment', { thread, text: 'Why return null here?' });
    return api.listThreads().find((t) => t.thread === thread)!.id;
  }

  async function agentSays(id: string, body: string, status: 'needs-info' | 'addressed' | 'none') {
    const before = managed(id).state.comments.length;
    assert.equal(
      await vscode.commands.executeCommand('localReview.dev.simulateAgentReply', { threadId: id, body, status }),
      true,
    );
    await waitFor('the agent reply', () => (managed(id).state.comments.length > before ? true : undefined));
  }

  const userReplies = (id: string, text: string) =>
    vscode.commands.executeCommand('localReview.reply', { thread: managed(id).thread, text });

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
  });

  it('lets the user reply in the thread, as the user', async () => {
    const id = await newThread(3);
    const t = managed(id).thread;
    assert.deepEqual(t.canReply, { name: t.comments[0]!.author.name });
  });

  it('adds the reply and hands a question back to the agent (AC 1–2)', async () => {
    const id = await newThread(4);
    await agentSays(id, 'Which error should it throw?', 'needs-info');
    await userReplies(id, 'A `NotFoundError`.');

    const t = managed(id);
    assert.deepEqual(
      t.thread.comments.map((c) => (c.body as vscode.MarkdownString).value),
      ['Why return null here?', 'Which error should it throw?', 'A `NotFoundError`.'],
    );
    assert.equal(t.thread.comments[2]!.contextValue, 'author-user');
    assert.equal(t.thread.label, 'Waiting for Claude');
    assert.deepEqual(
      journal(id)
        .slice(-2)
        .map((e) => [e.type, e.by, e.status]),
      [
        ['comment.added', 'user', undefined],
        ['status.changed', 'user', 'open'],
      ],
    );
  });

  it('hands an addressed thread back to the agent too (AC 3)', async () => {
    const id = await newThread(5);
    await agentSays(id, 'Done.', 'addressed');
    await userReplies(id, 'Not quite: the test still fails.');
    assert.equal(managed(id).state.status, 'open');
    assert.equal(managed(id).thread.label, 'Waiting for Claude');
  });

  it('keeps the order over several back-and-forths (AC 4)', async () => {
    const id = await newThread(6);
    for (let round = 1; round <= 3; round++) {
      await agentSays(id, `agent ${round}`, 'needs-info');
      await userReplies(id, `user ${round}`);
    }
    assert.deepEqual(
      managed(id).state.comments.map((c) => `${c.author}: ${c.body}`),
      [
        'user: Why return null here?',
        'agent: agent 1',
        'user: user 1',
        'agent: agent 2',
        'user: user 2',
        'agent: agent 3',
        'user: user 3',
      ],
    );
  });

  it('ignores an empty reply', async () => {
    const id = await newThread(7);
    await userReplies(id, '   ');
    assert.equal(journal(id).length, 2);
  });

  it('loses no message when the user replies while agent processes write (AC 5)', async () => {
    const id = await newThread(8);
    const script = join(extensionPath, 'dist', 'fake-agent.js');
    const N = 10;
    const agents = Array.from(
      { length: N },
      (_, i) =>
        new Promise<number | null>((resolve) =>
          fork(script, ['--root', ws, '--thread', id, '--body', `agent ${i}`], { stdio: 'ignore' }).on('exit', resolve),
        ),
    );
    const users = Array.from({ length: N }, (_, i) => userReplies(id, `user ${i}`));
    const codes = await Promise.all(agents);
    await Promise.all(users);
    assert.deepEqual(codes, Array(N).fill(0));

    const t = await waitFor('all messages', () => {
      const m = managed(id);
      return m.state.comments.length === 1 + 2 * N ? m : undefined;
    });
    const bodies = new Set(t.state.comments.map((c) => c.body));
    for (let i = 0; i < N; i++) {
      assert.ok(bodies.has(`agent ${i}`), `agent ${i} missing`);
      assert.ok(bodies.has(`user ${i}`), `user ${i} missing`);
    }
  });
});

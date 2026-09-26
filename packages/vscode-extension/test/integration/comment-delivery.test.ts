import * as assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { localReviewHome, SessionRegistry, type Delivery, type SessionRecord } from '@local-review/core';
import type { LocalReviewApi } from '../../src/extension';

const EXTENSION_ID = 'local.local-review';

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('Published comments go to the agent session', () => {
  let api: LocalReviewApi;
  let ws: string;
  let uri: vscode.Uri;
  let registry: SessionRegistry;
  let warnings: string[];
  let click: string | undefined;

  const session = (over: Partial<SessionRecord> = {}): SessionRecord => ({
    id: 'claude-1',
    agent: 'Claude',
    cwd: ws,
    branch: 'feature-x',
    pid: process.pid, // alive for as long as the test runs
    startedAt: new Date().toISOString(),
    push: true,
    ...over,
  });
  const inbox = async (id = 'claude-1'): Promise<Delivery[]> => (await registry.readInbox(id)).deliveries;
  const delivered = (n: number, id = 'claude-1') =>
    waitFor(`${n} deliveries`, async () => {
      const d = await inbox(id);
      return d.length >= n ? d : undefined;
    });

  async function comment(text: string, line: number, command = 'localReview.submitComment'): Promise<string> {
    const thread = api.controller.createCommentThread(uri, new vscode.Range(line, 0, line, 0), []);
    await vscode.commands.executeCommand(command, { thread, text });
    return api.listThreads().find((t) => t.thread === thread)!.id;
  }

  before(async () => {
    const ext = vscode.extensions.getExtension<LocalReviewApi>(EXTENSION_ID)!;
    api = await ext.activate();
    ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    uri = vscode.Uri.file(join(ws, 'sample.ts'));
    registry = new SessionRegistry(localReviewHome());
    api.setSummaryPrompt(async () => '');
    api.setDeliveryWarner(async (message, ...actions) => {
      warnings.push(`${message} [${actions.join('|')}]`);
      return click;
    });
  });

  beforeEach(async () => {
    rmSync(registry.dir, { recursive: true, force: true });
    rmSync(join(ws, '.local-review'), { recursive: true, force: true });
    await api.reload();
    warnings = [];
    click = undefined;
  });

  after(() => {
    api.setSummaryPrompt(undefined);
    api.setDeliveryWarner(undefined);
  });

  it('sends a direct comment right away', async () => {
    await registry.register(session());
    const id = await comment('Rename this', 1);
    const [d] = await delivered(1);
    assert.equal(d!.kind, 'comment');
    assert.deepEqual(d!.threadIds, [id]);
    assert.equal(d!.root, ws);
    assert.match(d!.id, /^d_/);
  });

  it('sends a reply published outside a review', async () => {
    await registry.register(session());
    const id = await comment('Rename this', 1);
    const thread = api.listThreads().find((t) => t.id === id)!.thread;
    await vscode.commands.executeCommand('localReview.reply', { thread, text: 'Also add a test' });
    const d = await delivered(2);
    assert.deepEqual(
      d.map((x) => [x.kind, x.threadIds]),
      [
        ['comment', [id]],
        ['reply', [id]],
      ],
    );
  });

  it('sends nothing for drafts, and the whole review once submitted', async () => {
    await registry.register(session());
    const a = await comment('First', 1, 'localReview.addToReview');
    const b = await comment('Second', 3, 'localReview.addToReview');
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(await inbox(), []);

    await vscode.commands.executeCommand('localReview.submitReview');
    const [d] = await delivered(1);
    assert.equal(d!.kind, 'review');
    assert.deepEqual([...d!.threadIds].sort(), [a, b].sort());
    assert.match(d!.reviewId!, /^r_/);
  });

  it('sends to the session of this folder that started last', async () => {
    await registry.register(session({ id: 'older', startedAt: '2026-09-26T09:00:00.000Z' }));
    await registry.register(session({ id: 'newer', startedAt: '2026-09-26T10:00:00.000Z' }));
    await registry.register(
      session({ id: 'elsewhere', cwd: '/some/other/project', startedAt: '2026-09-26T11:00:00.000Z' }),
    );
    await comment('Rename this', 1);
    await delivered(1, 'newer');
    assert.deepEqual(await inbox('older'), []);
    assert.deepEqual(await inbox('elsewhere'), []);
  });

  it('keeps the comment when no session runs', async () => {
    const id = await comment('Rename this', 1);
    assert.ok(api.listThreads().some((t) => t.id === id));
    assert.deepEqual(warnings, []);
  });

  it("warns once when the session can't be notified, with the command to relaunch it", async () => {
    await registry.register(session({ push: false, pushCommand: 'agent --notify' }));
    click = 'Copy Command';
    await comment('One', 1);
    await delivered(1); // still delivered: the agent sees it when asked
    await waitFor('the warning', async () => (warnings.length > 0 ? true : undefined));
    assert.deepEqual(warnings, [
      "Local Review: Claude · feature-x won't see your comments until you ask it, as its session can't be notified. To fix it, relaunch it with: agent --notify [Copy Command]",
    ]);
    assert.equal(await vscode.env.clipboard.readText(), 'agent --notify');

    await comment('Two', 3);
    await delivered(2);
    assert.equal(warnings.length, 1, 'not at every comment');
    assert.equal((await api.refreshSessions()).statusText, '$(hubot) Claude · feature-x $(warning)');
  });
});

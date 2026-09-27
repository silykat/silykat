import * as assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
  let asked: string[];
  let pickId: string | undefined;

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
    api.setSessionPicker(async (title, choices) => {
      asked.push(`${title} [${choices.map((c) => c.session.id + (c.note ? ` (${c.note})` : '')).join(', ')}]`);
      return pickId;
    });
  });

  beforeEach(async () => {
    rmSync(registry.dir, { recursive: true, force: true });
    rmSync(join(localReviewHome(), 'queue'), { recursive: true, force: true });
    rmSync(join(ws, '.local-review'), { recursive: true, force: true });
    await api.reload();
    warnings = [];
    click = undefined;
    asked = [];
    pickId = undefined;
  });

  after(() => {
    // Leave nothing waiting: a later poll would ask which session to use, and steal the focus.
    rmSync(registry.dir, { recursive: true, force: true });
    rmSync(join(localReviewHome(), 'queue'), { recursive: true, force: true });
    api.setSummaryPrompt(undefined);
    api.setDeliveryWarner(undefined);
    api.setSessionPicker(undefined);
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

  it('sends to the session that wrote the file, without asking', async () => {
    await registry.register(session({ id: 'writer', startedAt: '2026-09-26T09:00:00.000Z' }));
    await registry.register(session({ id: 'other', startedAt: '2026-09-26T10:00:00.000Z' }));
    await registry.touch('writer', uri.fsPath);
    await comment('Rename this', 1);
    await delivered(1, 'writer');
    assert.deepEqual(await inbox('other'), []);
    assert.deepEqual(asked, []);
  });

  it('sends a file written by a session working elsewhere (e.g. a spec) to that session', async () => {
    await registry.register(session({ id: 'here' }));
    await registry.register(session({ id: 'specs-writer', cwd: '/some/other/project' }));
    await registry.touch('specs-writer', uri.fsPath);
    await comment('Clarify this', 1);
    await delivered(1, 'specs-writer');
    assert.deepEqual(asked, []);
  });

  it('asks which session to use when several could be the one, proposing the last one used', async () => {
    await registry.register(session({ id: 'older', startedAt: '2026-09-26T09:00:00.000Z' }));
    await registry.register(session({ id: 'newer', startedAt: '2026-09-26T10:00:00.000Z' }));
    await registry.register(session({ id: 'elsewhere', cwd: '/some/other/project' }));
    pickId = 'older';
    await comment('Rename this', 1);
    await delivered(1, 'older');
    assert.equal(asked.length, 1);
    assert.match(asked[0]!, /several agent sessions work on .*\. Which one handles this comment\?/);
    assert.match(asked[0]!, /\[newer \(proposed\), older, elsewhere \(works elsewhere\)\]$/);

    pickId = undefined; // Esc: the comment waits
    await comment('And this', 3);
    await waitFor('the question', async () => (asked.length === 2 ? true : undefined));
    assert.match(asked[1]!, /\[older \(proposed\), newer, elsewhere \(works elsewhere\)\]$/, 'the last one used');
    assert.equal((await inbox('older')).length, 1);
    await waitFor('the waiting count', async () =>
      (await api.refreshSessions()).statusText?.endsWith(' · 1 waiting') ? true : undefined,
    );

    await api.flushDeliveries();
    assert.equal(asked.length, 2, 'not asked again while the sessions are the same');
    pickId = 'new-one'; // before it registers: the registry is also polled
    await registry.register(session({ id: 'new-one', startedAt: '2026-09-26T11:00:00.000Z' }));
    await api.flushDeliveries();
    await delivered(1, 'new-one');
    assert.equal(asked.length, 3);
  });

  it('sends to the session that works in that folder now, when both started in a parent folder', async () => {
    const parent = dirname(ws);
    await registry.register(session({ id: 'in-here', cwd: parent, workingDir: ws, branch: null }));
    await registry.register(session({ id: 'in-other', cwd: parent, workingDir: '/some/other/project', branch: null }));
    await comment('Rename this', 1);
    await delivered(1, 'in-here');
    assert.deepEqual(asked, []);
  });

  it('asks again at the next comment when the question was closed without an answer', async () => {
    await registry.register(session({ id: 'one' }));
    await registry.register(session({ id: 'two' }));
    pickId = undefined; // e.g. closed by another prompt
    const first = await comment('First', 1);
    await waitFor('the waiting comment', async () => ((await api.waitingCount()) === 1 ? true : undefined));
    pickId = 'two';
    const second = await comment('Second', 3);
    const [d] = await delivered(1, 'two');
    assert.deepEqual([...d!.threadIds].sort(), [first, second].sort(), 'the waiting one goes along');
    assert.equal(await api.waitingCount(), 0);
  });

  it('sends waiting comments to a session working elsewhere, on demand', async () => {
    await registry.register(session({ id: 'far', cwd: '/some/other/project' }));
    const id = await comment('Rename this', 1);
    await waitFor('the waiting comment', async () => ((await api.waitingCount()) === 1 ? true : undefined));
    pickId = 'far';
    await vscode.commands.executeCommand('localReview.sendWaitingComments');
    const [d] = await delivered(1, 'far');
    assert.deepEqual(d!.threadIds, [id]);
    assert.match(
      asked[asked.length - 1]!,
      /no agent session works on .*Which one handles the waiting comments\? \[far \(works elsewhere\)\]/,
    );
  });

  it('keeps the comments waiting when no session runs, and sends them when one starts there', async () => {
    await registry.register(session({ id: 'elsewhere', cwd: '/some/other/project' }));
    const id = await comment('Rename this', 1);
    await waitFor('the message', async () => (warnings.length > 0 ? true : undefined));
    assert.match(
      warnings[0]!,
      /no agent session works on .*\. Your comments will go to the next one started there\. \[Send to a Session…\]/,
    );
    assert.equal((await api.refreshSessions()).statusText, '$(hubot) No agent session · 1 waiting');

    await registry.register(session({ id: 'started' }));
    await api.flushDeliveries();
    const [d] = await delivered(1, 'started');
    assert.deepEqual(d!.threadIds, [id]);
    assert.equal((await api.refreshSessions()).statusText, '$(hubot) Claude · feature-x');
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

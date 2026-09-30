import * as assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import {
  localReviewHome,
  SessionRegistry,
  topicOf,
  type Delivery,
  type SessionRecord,
  type Topic,
} from '@local-review/core';
import type { LocalReviewApi } from '../../src/extension';
import { WAIT_MS } from './timing';

const EXTENSION_ID = 'local.local-review';

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = WAIT_MS): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('Published comments go to the subscribed agent sessions', () => {
  let api: LocalReviewApi;
  let ws: string;
  let uri: vscode.Uri;
  let branch: Topic;
  let registry: SessionRegistry;
  let warnings: string[];
  let click: string | undefined;
  let asked: string[];
  let answer: string | undefined;

  const session = (over: Partial<SessionRecord> = {}): SessionRecord => ({
    id: 'claude-1',
    agent: 'Claude',
    cwd: ws,
    branch: null,
    pid: process.pid, // alive for as long as the test runs
    startedAt: new Date().toISOString(),
    push: true,
    ...over,
  });
  /** A session subscribed to some topics (the branch of the workspace by default). */
  const subscribed = async (id: string, ...topics: Topic[]) => {
    await registry.register(session({ id }));
    for (const t of topics.length > 0 ? topics : [branch]) await registry.subscribe(id, t, 'modified');
  };
  const inbox = async (id = 'claude-1'): Promise<Delivery[]> => (await registry.readInbox(id)).deliveries;
  const delivered = (n: number, id = 'claude-1') =>
    waitFor(`${n} deliveries to ${id}`, async () => {
      const d = await inbox(id);
      return d.length >= n ? d : undefined;
    });
  const idOf = (thread: vscode.CommentThread) => api.listThreads().find((t) => t.thread === thread)?.id;

  async function comment(
    text: string,
    line: number,
    command = 'localReview.submitComment',
  ): Promise<string | undefined> {
    const thread = api.controller.createCommentThread(uri, new vscode.Range(line, 0, line, 0), []);
    await vscode.commands.executeCommand(command, { thread, text });
    return idOf(thread);
  }

  before(async () => {
    const ext = vscode.extensions.getExtension<LocalReviewApi>(EXTENSION_ID)!;
    api = await ext.activate();
    ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    uri = vscode.Uri.file(join(ws, 'sample.ts'));
    branch = await topicOf(uri.fsPath);
    registry = new SessionRegistry(localReviewHome());
    api.setSummaryPrompt(async () => '');
    api.setDeliveryWarner(async (message, ...actions) => {
      warnings.push(`${message} [${actions.join('|')}]`);
      return click;
    });
    api.setNoSubscriberPrompt(async (message, _detail, ...actions) => {
      asked.push(`${message} [${actions.join('|')}]`);
      return answer;
    });
  });

  beforeEach(async () => {
    rmSync(registry.dir, { recursive: true, force: true });
    rmSync(join(ws, '.local-review'), { recursive: true, force: true });
    await api.reload();
    warnings = [];
    click = undefined;
    asked = [];
    answer = 'Publish';
  });

  after(() => {
    // Nothing left registered for later files.
    rmSync(registry.dir, { recursive: true, force: true });
    api.setSummaryPrompt(undefined);
    api.setDeliveryWarner(undefined);
    api.setNoSubscriberPrompt(async () => 'Publish'); // as for every test file
  });

  it('is about the branch of the workspace, in these tests', () => {
    assert.equal(branch.kind, 'branch');
  });

  it('sends a direct comment to the session subscribed to its branch, without asking', async () => {
    await subscribed('claude-1');
    const id = await comment('Rename this', 1);
    const [d] = await delivered(1);
    assert.equal(d!.kind, 'comment');
    assert.deepEqual(d!.threadIds, [id]);
    assert.deepEqual(d!.recipients, ['claude-1']);
    assert.equal(d!.root, ws);
    assert.deepEqual(asked, []);
  });

  it('sends a reply published outside a review', async () => {
    await subscribed('claude-1');
    const id = (await comment('Rename this', 1))!;
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
    await subscribed('claude-1');
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

  it('sends to every session subscribed to the branch, and only to them', async () => {
    await subscribed('dev');
    await subscribed('reviewer');
    await subscribed('elsewhere', { kind: 'branch', repo: '/some/other/.git', branch: 'main' });
    await registry.register(session({ id: 'not-subscribed' })); // started here, subscribed to nothing
    await comment('Check this', 1);
    const [forDev] = await delivered(1, 'dev');
    const [forReviewer] = await delivered(1, 'reviewer');
    assert.deepEqual([...forDev!.recipients!].sort(), ['dev', 'reviewer']);
    assert.deepEqual(forReviewer!.threadIds, forDev!.threadIds);
    assert.deepEqual(await inbox('elsewhere'), []);
    assert.deepEqual(await inbox('not-subscribed'), []);
  });

  it('sends to a session subscribed to the folder or file itself', async () => {
    await subscribed('by-path', { kind: 'path', path: ws });
    await comment('Rename this', 1);
    await delivered(1, 'by-path');
  });

  it('warns when no session is subscribed, and lets the user cancel', async () => {
    await registry.register(session({ id: 'not-subscribed' }));
    answer = undefined; // Cancel
    assert.equal(await comment('Not now', 1), undefined, 'not saved');
    assert.equal(asked.length, 1);
    assert.match(
      asked[0]!,
      /^No agent session is subscribed to .*\. Publish this comment anyway\? \[Publish\|Publish, Don't Warn Again for This Folder\]$/,
    );

    answer = 'Publish';
    assert.ok(await comment('Saved anyway', 3), 'saved');
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(await inbox('not-subscribed'), [], 'sent to nobody');
  });

  it('keeps the drafts when a review nobody is subscribed to is cancelled', async () => {
    answer = 'Publish';
    await comment('Draft', 1, 'localReview.addToReview'); // drafts are never asked about
    assert.deepEqual(asked, []);
    answer = undefined;
    assert.equal(await vscode.commands.executeCommand<number>('localReview.submitReview'), 0);
    assert.match(asked[0]!, /Publish this comment anyway/);
    assert.equal(api.reviewsInProgress().length, 1, 'still in progress');
  });

  it("warns once when a subscribed session can't be notified, with the command to relaunch it", async () => {
    await registry.register(session({ push: false, pushCommand: 'agent --notify' }));
    await registry.subscribe('claude-1', branch, 'launch');
    click = 'Copy Command';
    await comment('One', 1);
    await delivered(1); // still delivered: the agent sees it when asked
    await waitFor('the warning', async () => (warnings.length > 0 ? true : undefined));
    assert.deepEqual(warnings, [
      "Local Review: Claude claude-1 won't see your comments until you ask it, as its session can't be notified. To fix it, relaunch it with: agent --notify [Copy Command]",
    ]);
    assert.equal(await vscode.env.clipboard.readText(), 'agent --notify');

    await comment('Two', 3);
    await delivered(2);
    assert.equal(warnings.length, 1, 'not at every comment');
    assert.equal((await api.refreshSessions()).statusText, '$(hubot) Claude claude-1 $(warning)');
  });

  // Last: muting lasts until VS Code closes.
  it('stops warning for the folder when asked to', async () => {
    answer = "Publish, Don't Warn Again for This Folder";
    assert.ok(await comment('One', 1));
    assert.ok(await comment('Two', 3));
    assert.equal(asked.length, 1);
  });
});

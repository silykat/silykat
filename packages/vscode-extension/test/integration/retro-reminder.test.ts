import * as assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { buildAnchorContext, readConfig, Store } from '@local-review/core';
import type { LocalReviewApi } from '../../src/extension';
import { WAIT_MS } from './timing';

const EXTENSION_ID = 'local.local-review';
const DAY = 86_400_000;

describe('Retro reminder', () => {
  let api: LocalReviewApi;
  let root: string;
  let shown: { message: string; actions: string[] }[];
  let answer: string | undefined;
  let threadId: string;
  const settings = () => vscode.workspace.getConfiguration('localReview.retroReminder');

  let retros = 0;
  /**
   * A finished retro of the workspace folder, whose period ended `daysAgo` days ago: its journal as
   * a retro writes it (a proposal adopted and applied).
   */
  const retroEnded = (daysAgo: number) => {
    const at = (offset: number) => new Date(Date.now() - daysAgo * DAY + offset).toISOString();
    const id = `rt_01M3ZT${String(++retros).padStart(20, '0')}`;
    const proposal = {
      id: 'p1',
      column: 'improve',
      subject: 'Dates are UTC',
      title: 'Say dates are UTC',
      kind: 'rule',
      file: 'CLAUDE.md',
      rule: null,
      change: '- Dates are UTC.',
      why: 'Two threads ask for UTC',
      cause: 'UTC not written',
      evidence: [],
      figures: { threads: 2, reopened: 0, questions: 0, rounds: 0, first: at(0), last: at(0) },
      target: 'project-shared',
      targetWhy: '',
      askTarget: false,
      confidence: 0.8,
      recommendation: 'accepted',
    };
    const events = [
      {
        type: 'retro.started',
        retroId: id,
        root,
        since: null,
        until: at(0),
        stores: [],
        threads: [],
        bytes: 0,
        preferences: [],
      },
      { type: 'retro.feedback', body: 'It helped' },
      { type: 'retro.classified', by: 'haiku', labels: {} },
      { type: 'retro.proposed', proposals: [proposal], watch: [], dropped: [] },
      { type: 'retro.decided', proposal: 'p1', decision: 'accepted' },
      { type: 'retro.applied', proposal: 'p1', files: [join(root, 'CLAUDE.md')] },
      { type: 'retro.conversation', thread: 't_1', sessions: [], available: false },
      { type: 'retro.finished' },
    ];
    const dir = join(root, '.local-review', 'retros');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${id}.jsonl`),
      events.map((e, i) => JSON.stringify({ v: 1, at: at(i + 1), ...e }) + '\n').join(''),
    );
  };
  const until = async (check: () => Promise<boolean>) => {
    const deadline = Date.now() + WAIT_MS;
    while (!(await check())) {
      if (Date.now() > deadline) assert.fail('timed out');
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  before(async () => {
    api = await vscode.extensions.getExtension<LocalReviewApi>(EXTENSION_ID)!.activate();
    root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    api.setRetroReminderPrompt(async (message, actions) => {
      shown.push({ message, actions });
      return answer;
    });
    // Something to look back at (about 1.5 KB).
    const thread = await new Store(root).createThread(
      {
        path: 'sample.ts',
        source: 'worktree',
        ref: null,
        sha: null,
        ...buildAnchorContext('const line1 = 1;\n', { startLine: 1, endLine: 1 }),
      },
      { author: 'user', body: 'Dates are UTC here. '.repeat(60), reviewId: null },
    );
    threadId = thread.id;
    await api.reload();
  });

  beforeEach(() => {
    shown = [];
    answer = undefined;
  });

  afterEach(async () => {
    rmSync(join(root, '.local-review', 'retros'), { recursive: true, force: true });
    for (const key of ['days', 'sizeKB', 'maxDays', 'statusBar', 'agentMessage'])
      await settings().update(key, undefined, vscode.ConfigurationTarget.Global);
  });

  after(async () => {
    api.setRetroReminderPrompt(undefined);
    await new Store(root).deleteThread(threadId, 'user');
    await api.reload();
  });

  it('shows the days and size since the last retro, and says when a retro is due', async () => {
    retroEnded(10);
    const due = await api.refreshRetroReminder();
    assert.match(due.statusText ?? '', /^\$\(bell-dot\) Retro due: 10 d · \d+(\.\d)? (B|KB)$/);
    assert.deepEqual(due.due, [root]);

    await settings().update('days', 30, vscode.ConfigurationTarget.Global);
    const later = await api.refreshRetroReminder();
    assert.match(later.statusText ?? '', /^\$\(history\) Retro: 10 d · /);
    assert.deepEqual(later.due, []);
    // Above the maximum, it is due whatever the days setting says.
    await settings().update('maxDays', 9, vscode.ConfigurationTarget.Global);
    assert.match((await api.refreshRetroReminder()).statusText ?? '', /^\$\(bell-dot\) Retro due: 10 d/);
    await settings().update('maxDays', undefined, vscode.ConfigurationTarget.Global);
    // Sooner for a big batch of threads.
    await settings().update('sizeKB', 1, vscode.ConfigurationTarget.Global);
    await settings().update('days', 30, vscode.ConfigurationTarget.Global);
    assert.match((await api.refreshRetroReminder()).statusText ?? '', /^\$\(bell-dot\) Retro due/);
  });

  it('passes the settings on to the agent hooks, through the machine settings', async () => {
    await settings().update('days', 12, vscode.ConfigurationTarget.Global);
    await settings().update('agentMessage', false, vscode.ConfigurationTarget.Global);
    await until(async () => {
      const c = await readConfig();
      return c.retroReminderDays === 12 && !c.retroReminder;
    });
    // Reset in VS Code: back to the default for the hooks too.
    await settings().update('days', undefined, vscode.ConfigurationTarget.Global);
    await settings().update('agentMessage', undefined, vscode.ConfigurationTarget.Global);
    await until(async () => {
      const c = await readConfig();
      return c.retroReminderDays === 7 && c.retroReminder;
    });
  });

  it('can show only a due retro, or nothing, and hides when nothing is new', async () => {
    retroEnded(3);
    assert.match((await api.refreshRetroReminder()).statusText ?? '', /^\$\(history\) Retro: 3 d/);
    await settings().update('statusBar', 'whenDue', vscode.ConfigurationTarget.Global);
    assert.equal((await api.refreshRetroReminder()).statusText, undefined);
    await settings().update('statusBar', 'never', vscode.ConfigurationTarget.Global);
    await settings().update('days', 2, vscode.ConfigurationTarget.Global);
    assert.equal((await api.refreshRetroReminder()).statusText, undefined);
    await settings().update('statusBar', undefined, vscode.ConfigurationTarget.Global);
    // A retro that read everything: nothing to look back at.
    retroEnded(-1);
    assert.equal((await api.refreshRetroReminder()).statusText, undefined);
  });

  it('explains how to run the retro on a click', async () => {
    retroEnded(8);
    answer = 'Copy /local-review:retro';
    const message = (await vscode.commands.executeCommand('localReview.showRetroReminder')) as string;
    assert.equal(shown.length, 1);
    assert.equal(shown[0]!.message, message);
    assert.match(
      message,
      /^Local Review: a retro is due for [^:]+: 8 days, .* and 0 agent sessions since the last retro/,
    );
    assert.ok(message.includes('To run it with Claude Code: /local-review:retro'), message);
    assert.deepEqual(shown[0]!.actions, ['Copy /local-review:retro', 'Reminder Settings']);
    assert.equal(await vscode.env.clipboard.readText(), '/local-review:retro');

    answer = undefined;
    await settings().update('days', 30, vscode.ConfigurationTarget.Global);
    const notYet = (await vscode.commands.executeCommand('localReview.showRetroReminder')) as string;
    assert.match(notYet, /no retro due yet .* Reminder at 25 days, or sooner at 1\.0 MB of threads\./);

    retroEnded(-1);
    const nothing = (await vscode.commands.executeCommand('localReview.showRetroReminder')) as string;
    assert.match(nothing, /nothing to look back at since the last retro/);
    assert.deepEqual(shown.at(-1)!.actions, ['Reminder Settings']);
  });
});

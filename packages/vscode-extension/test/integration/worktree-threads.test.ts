import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { buildAnchorContext, projectHistory, Store, type WorktreeSave } from '@silykat/core';
import type { SilykatApi } from '../../src/extension';

const EXTENSION_ID = 'silykat.silykat';

describe('Threads of git worktrees', () => {
  let api: SilykatApi;
  let parent: string;
  let main: string;
  let wt: string;
  let shown: string[];
  let answer: string | undefined;

  // A repository of its own: the workspace's git history belongs to the other tests.
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
      cwd: main,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  const commentIn = (root: string, body: string) =>
    new Store(root).createThread(
      {
        path: 'sample.ts',
        source: 'worktree',
        ref: null,
        sha: null,
        ...buildAnchorContext('const line1 = 1;\n', { startLine: 1, endLine: 1 }),
      },
      { author: 'user', body, reviewId: null },
    );
  const warnings = () => shown.filter((m) => m.includes('is a git worktree with comments'));

  before(async () => {
    const ext = vscode.extensions.getExtension<SilykatApi>(EXTENSION_ID)!;
    api = await ext.activate();
    api.setChooseHandler(async (message) => {
      shown.push(message);
      return answer;
    });
  });

  beforeEach(async () => {
    shown = [];
    answer = undefined;
    await api.forgetWorktreeWarnings();
    parent = realpathSync(mkdtempSync(join(tmpdir(), 'slk-wt-')));
    main = join(parent, 'main');
    wt = join(parent, 'feature-wt');
    mkdirSync(main);
    writeFileSync(join(main, 'sample.ts'), 'const line1 = 1;\n');
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('commit', '-qm', 'first commit');
    git('worktree', 'add', '-q', '-b', 'feature', wt);
  });

  afterEach(async () => {
    rmSync(parent, { recursive: true, force: true });
  });

  after(async () => {
    api.setChooseHandler(undefined);
    await api.forgetWorktreeWarnings();
  });

  it('saves the threads of a worktree to the main repository, where the history keeps them', async () => {
    const t = await commentIn(wt, 'Keep me after the worktree is gone');
    const saved = (await vscode.commands.executeCommand('silykat.saveWorktreeThreads', vscode.Uri.file(wt))) as
      WorktreeSave | undefined;
    assert.equal(saved?.published, 1);
    assert.equal(saved?.main, main);

    git('worktree', 'remove', '--force', wt);
    const h = await projectHistory(main);
    const found = h.stores.find((s) => s.origin === 'saved')?.threads.find((x) => x.id === t.id);
    assert.equal(
      found?.conversation[0]?.kind === 'comment' && found.conversation[0].body,
      'Keep me after the worktree is gone',
    );
  });

  it('warns once about a worktree with comments, and saves its threads from the warning', async () => {
    await commentIn(wt, 'In a worktree');
    answer = 'Save Threads Now';
    await api.warnIfWorktree(wt);
    assert.equal(warnings().length, 1);
    assert.match(warnings()[0]!, /git worktree remove/);
    assert.match(warnings()[0]!, /silykat: Save Worktree Threads/);
    assert.match(warnings()[0]!, /slk worktree save/);
    assert.equal((await projectHistory(main)).stores.filter((s) => s.origin === 'saved').length, 0); // still live: no duplicate
    rmSync(join(wt, '.silykat'), { recursive: true, force: true });
    assert.equal((await projectHistory(main)).stores.filter((s) => s.origin === 'saved').length, 1);

    await api.warnIfWorktree(wt);
    assert.equal(warnings().length, 1);
  });

  it('never warns about the main worktree, and finds no worktree to save among the open folders', async () => {
    await api.warnIfWorktree(main);
    assert.equal(warnings().length, 0);
    assert.equal(await vscode.commands.executeCommand('silykat.saveWorktreeThreads'), undefined);
  });
});

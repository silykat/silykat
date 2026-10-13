import * as assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { SilykatApi } from '../../src/extension';
import { WAIT_MS } from './timing';

const EXTENSION_ID = 'silykat.silykat';

async function waitFor(what: string, probe: () => boolean, timeoutMs = WAIT_MS): Promise<void> {
  const start = Date.now();
  while (!probe()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('Archive and clean up threads', () => {
  let api: SilykatApi;
  let ws: string;
  let uri: vscode.Uri;
  let informed: string[];
  let confirmed: { message: string; detail: string; action: string }[];
  let answer: boolean;
  let slkScript: string;

  /** Runs the real, bundled `slk` in its own process, as an agent asked by the user does. */
  const slk = (...args: string[]) =>
    new Promise<{ code: number | null; stdout: string }>((done) => {
      const child = fork(slkScript, args, { cwd: ws, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      let stdout = '';
      child.stdout!.on('data', (c: Buffer) => (stdout += c.toString()));
      child.on('exit', (code) => done({ code, stdout }));
    });

  const journal = (id: string) => join(ws, '.silykat', 'threads', `${id}.jsonl`);
  const events = (id: string) =>
    readFileSync(journal(id), 'utf8')
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l) as { v: number; type: string; by: string });
  const shown = () => api.listThreads().map((t) => t.id);
  const managed = (id: string) => api.listThreads().find((t) => t.id === id)!;
  const tomorrow = () => {
    const d = new Date(Date.now() + 86_400_000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  async function newThread(line: number, text = 'Rename this variable'): Promise<string> {
    const thread = api.controller.createCommentThread(uri, new vscode.Range(line, 0, line, 0), []);
    await vscode.commands.executeCommand('silykat.submitComment', { thread, text });
    return api.listThreads().find((t) => t.thread === thread)!.id;
  }
  const resolve = (id: string) => vscode.commands.executeCommand('silykat.resolveThread', managed(id).thread);

  before(async () => {
    const ext = vscode.extensions.getExtension<SilykatApi>(EXTENSION_ID)!;
    api = await ext.activate();
    ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    uri = vscode.Uri.file(join(ws, 'sample.ts'));
    slkScript = join(ext.extensionPath, '..', 'cli', 'dist', 'slk.js');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  });

  beforeEach(async () => {
    informed = [];
    confirmed = [];
    answer = true;
    rmSync(join(ws, '.silykat'), { recursive: true, force: true });
    await api.reload();
    api.setConfirmHandler(async (message, detail, action) => {
      confirmed.push({ message, detail, action });
      return answer;
    });
    api.setArchivePrompts({ askDate: async () => tomorrow(), inform: (m) => informed.push(m) });
  });

  after(async () => {
    api.setConfirmHandler(undefined);
    api.setArchivePrompts(undefined);
    rmSync(join(ws, '.silykat'), { recursive: true, force: true });
    await api.reload();
  });

  it('archives a thread from its header: gone from VS Code, kept in the journal (format 2)', async () => {
    const id = await newThread(2);
    const other = await newThread(4);
    await vscode.commands.executeCommand('silykat.archiveThread', managed(id).thread);

    assert.deepEqual(shown(), [other]);
    assert.deepEqual(
      events(id).map((e) => [e.type, e.v, e.by]),
      [
        ['thread.created', 1, 'user'],
        ['comment.added', 1, 'user'],
        ['thread.archived', 2, 'user'],
      ],
    );
    assert.equal(readFileSync(join(ws, '.silykat', 'schema-version'), 'utf8'), '2\n');
    // Still gone after a reload: archived is recorded, not just hidden.
    await api.reload();
    assert.deepEqual(shown(), [other]);
  });

  it('archives the threads resolved before a date, after saying how many, and brings back the ones picked', async () => {
    const a = await newThread(2, 'First');
    const b = await newThread(4, 'Second');
    const open = await newThread(6, 'Still open');
    await resolve(a);
    await resolve(b);

    answer = false;
    await vscode.commands.executeCommand('silykat.archiveResolvedThreads');
    assert.equal(confirmed[0]?.message, 'Archive 2 resolved threads?');
    assert.deepEqual(shown().sort(), [a, b, open].sort()); // cancelled: nothing archived

    answer = true;
    await vscode.commands.executeCommand('silykat.archiveResolvedThreads');
    assert.deepEqual(shown(), [open]);
    assert.ok(informed.includes('silykat: 2 threads archived.'), informed.join('\n'));

    let offered: string[] = [];
    api.setArchivePrompts({
      askDate: async () => tomorrow(),
      inform: (m) => informed.push(m),
      pickThreads: async (items) => {
        offered = items.map((i) => `${i.label} · ${i.detail}`);
        return items.filter((i) => i.thread.thread.id === a);
      },
    });
    await vscode.commands.executeCommand('silykat.showArchivedThreads');
    assert.deepEqual(offered.sort(), ['sample.ts:3 · First', 'sample.ts:5 · Second']);
    assert.deepEqual(shown().sort(), [a, open].sort());
    assert.equal(managed(a).state.status, 'resolved');
    assert.ok(informed.includes('silykat: 1 thread unarchived.'));
  });

  it('says when there is nothing to archive or bring back', async () => {
    await newThread(2);
    await vscode.commands.executeCommand('silykat.archiveResolvedThreads');
    await vscode.commands.executeCommand('silykat.showArchivedThreads');
    assert.equal(confirmed.length, 0);
    assert.deepEqual(informed, [
      `silykat: no resolved thread to archive before ${tomorrow()}.`,
      'silykat: no archived thread.',
    ]);
  });

  it('exports every thread, archived ones included, to a JSON file', async () => {
    const a = await newThread(2);
    const b = await newThread(4);
    await vscode.commands.executeCommand('silykat.archiveThread', managed(a).thread);
    const file = join(mkdtempSync(join(tmpdir(), 'slk-export-')), 'threads.json');
    let proposed = '';
    api.setArchivePrompts({
      inform: (m) => informed.push(m),
      askSaveLocation: async (defaultUri) => {
        proposed = defaultUri.fsPath;
        return vscode.Uri.file(file);
      },
    });
    await vscode.commands.executeCommand('silykat.exportThreads');

    assert.match(proposed, /silykat-threads-\d{4}-\d{2}-\d{2}\.json$/);
    const exported = JSON.parse(readFileSync(file, 'utf8')) as {
      threads: number;
      projects: { threads: { id: string; archivedAt: string | null }[] }[];
    };
    const threads = exported.projects.flatMap((p) => p.threads);
    assert.deepEqual(threads.map((t) => t.id).sort(), [a, b].sort());
    assert.ok(threads.find((t) => t.id === a)!.archivedAt);
    assert.equal(threads.find((t) => t.id === b)!.archivedAt, null);
    assert.ok(informed.includes(`silykat: 2 threads exported to ${file}.`));
    rmSync(join(file, '..'), { recursive: true, force: true });
  });

  it('deletes the old finished threads for good, after a confirmation with their number', async () => {
    const resolved = await newThread(2);
    const archived = await newThread(4);
    const open = await newThread(6);
    await resolve(resolved);
    await vscode.commands.executeCommand('silykat.archiveThread', managed(archived).thread);

    answer = false;
    await vscode.commands.executeCommand('silykat.deleteOldThreads');
    assert.equal(confirmed[0]?.message, 'Delete 2 threads permanently?');
    assert.match(confirmed[0]!.detail, /1 older thread still in progress is kept/);
    assert.ok(existsSync(journal(resolved)) && existsSync(journal(archived)));

    answer = true;
    await vscode.commands.executeCommand('silykat.deleteOldThreads');
    assert.equal(confirmed[1]?.action, 'Delete 2 Threads');
    assert.ok(informed.includes('silykat: 2 threads deleted permanently.'), informed.join('\n'));
    assert.equal(existsSync(journal(resolved)), false);
    assert.equal(existsSync(journal(archived)), false);
    assert.deepEqual(shown(), [open]);
  });

  it('follows slk review archive and slk review unarchive run outside VS Code', async () => {
    const id = await newThread(2);
    const other = await newThread(4);
    const archived = await slk('review', 'archive', id);
    assert.equal(archived.code, 0, archived.stdout);
    await waitFor('the archived thread to leave VS Code', () => !shown().includes(id));
    assert.deepEqual(shown(), [other]);

    const back = await slk('review', 'unarchive', id);
    assert.equal(back.code, 0, back.stdout);
    await waitFor('the unarchived thread to come back', () => shown().includes(id));
  });
});

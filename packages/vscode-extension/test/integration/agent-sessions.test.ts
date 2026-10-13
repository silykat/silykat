import * as assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { silykatHome, SessionRegistry, type SessionRecord } from '@silykat/core';
import type { SilykatApi } from '../../src/extension';

const EXTENSION_ID = 'silykat.silykat';

describe('Agent sessions of this workspace', () => {
  let api: SilykatApi;
  let ws: string;
  let registry: SessionRegistry;

  const session = (over: Partial<SessionRecord>): SessionRecord => ({
    id: 'claude-1',
    agent: 'Claude',
    cwd: ws,
    branch: 'feature-x',
    pid: process.pid, // alive for as long as the test runs
    startedAt: new Date().toISOString(),
    ...over,
  });

  before(async () => {
    const ext = vscode.extensions.getExtension<SilykatApi>(EXTENSION_ID)!;
    api = await ext.activate();
    ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    registry = new SessionRegistry(silykatHome());
  });

  // Nothing registered or waiting may leak between tests (or into later files: sessions left
  // behind would make their comments ask which session to use).
  const clean = () => {
    rmSync(registry.dir, { recursive: true, force: true });
    rmSync(join(silykatHome(), 'queue'), { recursive: true, force: true });
  };
  beforeEach(clean);
  after(clean);

  it('uses a private silykat home in tests', () => {
    assert.ok(process.env.SILYKAT_HOME, 'SILYKAT_HOME is set by the test config');
  });

  it('shows nothing when no agent runs', async () => {
    assert.equal((await api.refreshSessions()).statusText, undefined);
  });

  it('shows a session started in this workspace, with its short id', async () => {
    await registry.register(session({}));
    const shown = await api.refreshSessions();
    assert.equal(shown.statusText, '$(hubot) Claude claude-1');
    assert.deepEqual(shown.relevant, ['claude-1']);
  });

  it('counts several sessions, and leaves out those of other projects', async () => {
    await registry.register(session({ id: 'a', cwd: join(ws, 'sub') }));
    await registry.register(session({ id: 'b', branch: 'feature-y' }));
    await registry.register(session({ id: 'elsewhere', cwd: '/some/other/project' }));
    const shown = await api.refreshSessions();
    assert.equal(shown.statusText, '$(hubot) 2 agent sessions');
    assert.deepEqual(shown.relevant.sort(), ['a', 'b']);
    assert.deepEqual(shown.all.sort(), ['a', 'b', 'elsewhere']);
  });

  it('counts a session working elsewhere that is subscribed to a file here', async () => {
    await registry.register(session({ id: 'specs', cwd: '/some/other/code' }));
    await registry.subscribe('specs', { kind: 'path', path: join(ws, 'plan.md') }, 'modified');
    assert.deepEqual((await api.refreshSessions()).relevant, ['specs']);
  });

  it('drops a session when it ends, or when its process is gone', async () => {
    await registry.register(session({ id: 'ending' }));
    await registry.register(session({ id: 'crashed', pid: 999_999 }));
    assert.deepEqual((await api.refreshSessions()).relevant, ['ending']);
    await registry.unregister('ending');
    assert.equal((await api.refreshSessions()).statusText, undefined);
  });

  it('picks up a new session, and notices a crash, by itself within seconds', async () => {
    const waitUntil = async (what: string, ok: () => boolean) => {
      const start = Date.now();
      while (!ok()) {
        assert.ok(Date.now() - start < 5000, `${what} within a few seconds`);
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    await registry.register(session({ id: 'late' }));
    await waitUntil('seen', () => api.shownSessions().includes('late')); // no explicit refresh
    await registry.register(session({ id: 'late', pid: 999_999 })); // its process is now gone
    await waitUntil('dropped', () => !api.shownSessions().includes('late'));
  });
});

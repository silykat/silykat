import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { readConfig } from '@silykat/core';
import type { SilykatApi } from '../../src/extension';
import { WAIT_MS } from './timing';

const EXTENSION_ID = 'silykat.silykat';

async function until(what: string, probe: () => Promise<boolean> | boolean, timeoutMs = WAIT_MS): Promise<void> {
  const start = Date.now();
  while (!(await probe())) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('How a retro reads the agent sessions', () => {
  const settings = () => vscode.workspace.getConfiguration('silykat');

  before(async () => {
    await vscode.extensions.getExtension<SilykatApi>(EXTENSION_ID)!.activate();
  });

  after(async () => {
    await settings().update('retroSessions', undefined, vscode.ConfigurationTarget.Global);
    await until('the machine setting back to reports', async () => (await readConfig()).retroSessions === 'reports');
    await settings().update('retroSources.audit', undefined, vscode.ConfigurationTarget.Global);
    await until('the audit back to ask', async () => (await readConfig()).retroSourceAudit === 'ask');
  });

  it('reads their reports by default, and follows the VS Code setting on the machine', async () => {
    assert.equal(settings().get('retroSessions'), 'reports');
    await settings().update('retroSessions', 'insights', vscode.ConfigurationTarget.Global);
    await until('the machine setting set to insights', async () => (await readConfig()).retroSessions === 'insights');
    await settings().update('retroSessions', undefined, vscode.ConfigurationTarget.Global);
    await until('the machine setting back to reports', async () => (await readConfig()).retroSessions === 'reports');
  });

  it('reads each source as asked by default, and follows the VS Code setting on the machine', async () => {
    for (const source of ['reviews', 'sessions', 'audit'])
      assert.equal(settings().get(`retroSources.${source}`), 'ask');
    await settings().update('retroSources.audit', 'no', vscode.ConfigurationTarget.Global);
    await until('the audit set to no', async () => (await readConfig()).retroSourceAudit === 'no');
    // The other settings are untouched.
    assert.equal((await readConfig()).retroSourceReviews, 'ask');
    await settings().update('retroSources.audit', undefined, vscode.ConfigurationTarget.Global);
    await until('the audit back to ask', async () => (await readConfig()).retroSourceAudit === 'ask');
  });
});

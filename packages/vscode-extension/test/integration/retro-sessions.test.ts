import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { readConfig } from '@local-review/core';
import type { LocalReviewApi } from '../../src/extension';
import { WAIT_MS } from './timing';

const EXTENSION_ID = 'local.local-review';

async function until(what: string, probe: () => Promise<boolean> | boolean, timeoutMs = WAIT_MS): Promise<void> {
  const start = Date.now();
  while (!(await probe())) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('How a retro reads the agent sessions', () => {
  const settings = () => vscode.workspace.getConfiguration('localReview');

  before(async () => {
    await vscode.extensions.getExtension<LocalReviewApi>(EXTENSION_ID)!.activate();
  });

  after(async () => {
    await settings().update('retroSessions', undefined, vscode.ConfigurationTarget.Global);
    await until('the machine setting back to reports', async () => (await readConfig()).retroSessions === 'reports');
  });

  it('reads their reports by default, and follows the VS Code setting on the machine', async () => {
    assert.equal(settings().get('retroSessions'), 'reports');
    await settings().update('retroSessions', 'insights', vscode.ConfigurationTarget.Global);
    await until('the machine setting set to insights', async () => (await readConfig()).retroSessions === 'insights');
    await settings().update('retroSessions', undefined, vscode.ConfigurationTarget.Global);
    await until('the machine setting back to reports', async () => (await readConfig()).retroSessions === 'reports');
  });
});

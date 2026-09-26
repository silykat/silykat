import { fork } from 'node:child_process';
import * as vscode from 'vscode';
import type { ReviewController } from '../controller';

type SimulatedStatus = 'needs-info' | 'addressed' | 'none';

/** Arguments accepted from `executeCommand`, so tests can skip the pickers. */
export interface SimulateArgs {
  threadId?: string;
  body?: string;
  status?: SimulatedStatus;
}

/**
 * "Local Review (dev): Simulate Claude Reply". Stand-in for the Claude skill (step 2): it runs
 * `dist/fake-claude.js` in a separate process, so the reply reaches VS Code through the file
 * watcher exactly like a real one would.
 */
export async function simulateClaudeReply(
  review: ReviewController,
  extensionUri: vscode.Uri,
  args: SimulateArgs = {},
): Promise<boolean> {
  // Claude only sees published, unresolved threads.
  const candidates = review
    .listThreads()
    .filter((t) => t.state.hasPublished && t.state.status !== 'resolved' && !t.state.readOnly);
  if (candidates.length === 0) {
    void vscode.window.showInformationMessage('Local Review: no thread for Claude to reply to. Leave a comment first.');
    return false;
  }

  const target = args.threadId
    ? candidates.find((t) => t.id === args.threadId)
    : (
        await vscode.window.showQuickPick(
          candidates.map((t) => {
            const r = t.state.anchor.range;
            const first = t.state.comments.find((c) => !c.isDraft);
            return {
              label: `${t.state.anchor.path}${r ? `:${r.startLine}-${r.endLine}` : ''}`,
              description: first?.body.split('\n')[0],
              detail: t.thread.label,
              value: t,
            };
          }),
          { title: 'Simulate Claude Reply (1/3)', placeHolder: 'Thread Claude replies to' },
        )
      )?.value;
  if (!target) return false;

  const body =
    args.body ??
    (await vscode.window.showInputBox({
      title: 'Simulate Claude Reply (2/3)',
      prompt: 'Claude’s reply (Markdown)',
      value: 'Why this choice?',
      validateInput: (v) => (v.trim() === '' ? 'The reply cannot be empty' : undefined),
    }));
  if (body === undefined) return false;

  const status =
    args.status ??
    (
      await vscode.window.showQuickPick(
        [
          { label: '$(question) Question', description: 'Claude needs your reply', value: 'needs-info' as const },
          { label: '$(check) Addressed', description: 'Claude says it is done — please verify', value: 'addressed' as const },
          { label: '$(comment) Reply only', description: 'No status change', value: 'none' as const },
        ],
        { title: 'Simulate Claude Reply (3/3)', placeHolder: 'Thread status after the reply' },
      )
    )?.value;
  if (!status) return false;

  const script = vscode.Uri.joinPath(extensionUri, 'dist', 'fake-claude.js').fsPath;
  const result = await runScript(script, ['--root', target.rootPath, '--thread', target.id, '--body', body, '--status', status]);
  if (result.code !== 0) {
    void vscode.window.showErrorMessage(`Local Review: simulated reply failed. ${result.stderr.trim()}`);
    return false;
  }
  return true;
}

function runScript(script: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    // fork() reuses VS Code's own Node runtime: no dependency on a `node` binary in PATH.
    const child = fork(script, args, { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (err) => resolve({ code: 1, stderr: String(err) }));
    child.on('exit', (code) => resolve({ code: code ?? 1, stderr }));
  });
}

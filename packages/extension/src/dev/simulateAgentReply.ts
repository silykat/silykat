import { fork } from 'node:child_process';
import * as vscode from 'vscode';
import type { ReviewController } from '../controller';
import { DEFAULT_AGENT_NAME } from '../render';

type SimulatedStatus = 'needs-info' | 'addressed' | 'none';

/** Arguments accepted from `executeCommand`, so tests can skip the pickers. */
export interface SimulateArgs {
  threadId?: string;
  body?: string;
  status?: SimulatedStatus;
  /** Agent display name; defaults to the default agent. */
  agent?: string;
}

/**
 * "Local Review (dev): Simulate Agent Reply". Stand-in for a real agent integration (step 2): it
 * runs `dist/fake-agent.js` in a separate process, so the reply reaches VS Code through the file
 * watcher exactly like a real one would.
 */
export async function simulateAgentReply(
  review: ReviewController,
  extensionUri: vscode.Uri,
  args: SimulateArgs = {},
): Promise<boolean> {
  const agent = args.agent ?? DEFAULT_AGENT_NAME;
  // Agents only see published, unresolved threads.
  const candidates = review
    .listThreads()
    .filter((t) => t.state.hasPublished && t.state.status !== 'resolved' && !t.state.readOnly);
  if (candidates.length === 0) {
    void vscode.window.showInformationMessage(`Local Review: no thread for ${agent} to reply to. Leave a comment first.`);
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
          { title: 'Simulate Agent Reply (1/3)', placeHolder: `Thread ${agent} replies to` },
        )
      )?.value;
  if (!target) return false;

  const body =
    args.body ??
    (await vscode.window.showInputBox({
      title: 'Simulate Agent Reply (2/3)',
      prompt: `Reply as ${agent} (Markdown)`,
      value: 'Why this choice?',
      validateInput: (v) => (v.trim() === '' ? 'The reply cannot be empty' : undefined),
    }));
  if (body === undefined) return false;

  const status =
    args.status ??
    (
      await vscode.window.showQuickPick(
        [
          { label: '$(question) Question', description: `${agent} needs your reply`, value: 'needs-info' as const },
          { label: '$(check) Addressed', description: `${agent} says it is done — please verify`, value: 'addressed' as const },
          { label: '$(comment) Reply only', description: 'No status change', value: 'none' as const },
        ],
        { title: 'Simulate Agent Reply (3/3)', placeHolder: 'Thread status after the reply' },
      )
    )?.value;
  if (!status) return false;

  const script = vscode.Uri.joinPath(extensionUri, 'dist', 'fake-agent.js').fsPath;
  const result = await runScript(script, ['--root', target.rootPath, '--thread', target.id, '--body', body, '--status', status, '--agent', agent]);
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

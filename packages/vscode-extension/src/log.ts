import * as vscode from 'vscode';

export type Log = vscode.LogOutputChannel;

export function createLog(): Log {
  return vscode.window.createOutputChannel('silykat', { log: true });
}

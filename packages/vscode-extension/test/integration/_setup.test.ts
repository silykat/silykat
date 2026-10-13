import * as vscode from 'vscode';
import type { SilykatApi } from '../../src/extension';

// Root hook, for every test file: publishing without any subscribed agent session asks the user in
// a modal dialog, which would block the tests. Tests about that dialog set their own answer.
before(async () => {
  const api = await vscode.extensions.getExtension<SilykatApi>('silykat.silykat')!.activate();
  api.setNoSubscriberPrompt(async () => 'Publish');
});

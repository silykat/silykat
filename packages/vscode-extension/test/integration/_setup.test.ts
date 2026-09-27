import * as vscode from 'vscode';
import type { LocalReviewApi } from '../../src/extension';

// Root hook, for every test file: publishing without any subscribed agent session asks the user in
// a modal dialog, which would block the tests. Tests about that dialog set their own answer.
before(async () => {
  const api = await vscode.extensions.getExtension<LocalReviewApi>('local.local-review')!.activate();
  api.setNoSubscriberPrompt(async () => 'Publish');
});

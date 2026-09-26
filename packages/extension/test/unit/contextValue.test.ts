import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ThreadStatus } from '@local-review/core';
import { threadContextValue } from '../../src/contextValue';

const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const titleMenu: { command: string; when: string }[] = manifest.contributes.menus['comments/commentThread/title'];

/** Evaluates only the `commentThread =~ /…/` part of a when clause. */
function shownFor(command: string, contextValue: string): boolean {
  const item = titleMenu.find((m) => m.command === command);
  if (!item) throw new Error(`${command} is not in the thread title menu`);
  const regex = /commentThread =~ \/(.+?)\/(\s|$)/.exec(item.when)?.[1];
  if (!regex) throw new Error(`no commentThread regex in: ${item.when}`);
  return new RegExp(regex).test(contextValue);
}

const STATUSES: ThreadStatus[] = ['open', 'needs-info', 'addressed', 'resolved'];

describe('thread header actions', () => {
  it('offers Resolve on every unresolved thread, and Reopen only on resolved ones', () => {
    for (const status of STATUSES) {
      const cv = threadContextValue({ status, readOnly: false });
      expect(shownFor('localReview.resolveThread', cv), `Resolve on ${status}`).toBe(status !== 'resolved');
      expect(shownFor('localReview.reopenThread', cv), `Reopen on ${status}`).toBe(status === 'resolved');
    }
  });

  it('offers no write action on read-only threads', () => {
    for (const status of STATUSES) {
      const cv = threadContextValue({ status, readOnly: true });
      expect(shownFor('localReview.resolveThread', cv)).toBe(false);
      expect(shownFor('localReview.reopenThread', cv)).toBe(false);
    }
  });
});

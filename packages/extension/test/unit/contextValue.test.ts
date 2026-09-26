import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ThreadStatus } from '@local-review/core';
import { commentContextValue, threadContextValue } from '../../src/contextValue';

const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
type MenuItem = { command: string; when: string };
const titleMenu: MenuItem[] = manifest.contributes.menus['comments/commentThread/title'];
const commentMenus: MenuItem[] = [
  ...manifest.contributes.menus['comments/comment/title'],
  ...manifest.contributes.menus['comments/comment/context'],
];

/** Evaluates only the `comment == …` part of a when clause. */
function shownForComment(command: string, contextValue: string): boolean {
  const item = commentMenus.find((m) => m.command === command);
  if (!item) throw new Error(`${command} is not in the comment menus`);
  const expected = /comment == ([\w-]+)/.exec(item.when)?.[1];
  if (!expected) throw new Error(`no comment == … in: ${item.when}`);
  return contextValue === expected;
}

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

describe('comment actions', () => {
  const COMMENT_ACTIONS = [
    'localReview.editComment',
    'localReview.deleteComment',
    'localReview.saveEdit',
    'localReview.cancelEdit',
  ];

  it('offers edit and delete on the user’s comments only', () => {
    for (const command of COMMENT_ACTIONS) {
      expect(shownForComment(command, commentContextValue({ author: 'user' })), command).toBe(true);
      expect(shownForComment(command, commentContextValue({ author: 'agent' })), command).toBe(false);
    }
  });

  it('offers Delete Thread on any writable thread, never on read-only ones', () => {
    for (const status of STATUSES) {
      expect(shownFor('localReview.deleteThread', threadContextValue({ status, readOnly: false }))).toBe(true);
      expect(shownFor('localReview.deleteThread', threadContextValue({ status, readOnly: true }))).toBe(false);
    }
  });
});

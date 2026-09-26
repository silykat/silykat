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
      const cv = threadContextValue({ status, readOnly: false, onlyDrafts: false });
      expect(shownFor('localReview.resolveThread', cv), `Resolve on ${status}`).toBe(status !== 'resolved');
      expect(shownFor('localReview.reopenThread', cv), `Reopen on ${status}`).toBe(status === 'resolved');
    }
  });

  it('offers no write action on read-only threads', () => {
    for (const status of STATUSES) {
      const cv = threadContextValue({ status, readOnly: true, onlyDrafts: false });
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
      expect(
        shownFor('localReview.deleteThread', threadContextValue({ status, readOnly: false, onlyDrafts: false })),
      ).toBe(true);
      expect(
        shownFor('localReview.deleteThread', threadContextValue({ status, readOnly: true, onlyDrafts: false })),
      ).toBe(false);
    }
  });
});

describe('draft-only threads (US-08)', () => {
  const inputMenu: MenuItem[] = manifest.contributes.menus['comments/commentThread/context'];
  const regexShown = (command: string, contextValue: string) =>
    inputMenu
      .filter((m) => m.command === command && m.when.includes('!commentThreadIsEmpty'))
      .some((m) => new RegExp(/commentThread =~ \/(.+?)\/(\s|$)/.exec(m.when)![1]!).test(contextValue));

  it('are tagged as drafts', () => {
    expect(threadContextValue({ status: 'open', readOnly: false, onlyDrafts: true })).toBe('lr draft open');
  });

  it('can be deleted but not resolved', () => {
    const cv = threadContextValue({ status: 'open', readOnly: false, onlyDrafts: true });
    expect(shownFor('localReview.deleteThread', cv)).toBe(true);
    expect(shownFor('localReview.resolveThread', cv)).toBe(false);
  });

  it('take draft replies ("Add to Review"), never published ones ("Reply")', () => {
    const draft = threadContextValue({ status: 'open', readOnly: false, onlyDrafts: true });
    const published = threadContextValue({ status: 'open', readOnly: false, onlyDrafts: false });
    expect(regexShown('localReview.addToReview', draft)).toBe(true);
    expect(regexShown('localReview.reply', draft)).toBe(false);
    expect(regexShown('localReview.reply', published)).toBe(true);
  });
});

describe('buttons of a published thread (US-09)', () => {
  const inputMenu: MenuItem[] = manifest.contributes.menus['comments/commentThread/context'];
  /** Commands shown under an existing thread's input, for a context value and review state. */
  const buttons = (contextValue: string, reviewActive: boolean) =>
    inputMenu
      .filter((m) => m.when.includes('!commentThreadIsEmpty'))
      .filter((m) => new RegExp(/commentThread =~ \/(.+?)\/(\s|$)/.exec(m.when)![1]!).test(contextValue))
      .filter((m) =>
        m.when.includes('!localReview.reviewActive')
          ? !reviewActive
          : m.when.includes('localReview.reviewActive')
            ? reviewActive
            : true,
      )
      .sort((a, b) => ((a as { group?: string }).group ?? '').localeCompare((b as { group?: string }).group ?? ''))
      .map((m) => m.command);
  const published = threadContextValue({ status: 'needs-info', readOnly: false, onlyDrafts: false });
  const draftOnly = threadContextValue({ status: 'open', readOnly: false, onlyDrafts: true });

  it('offers "Reply" when no review is in progress', () => {
    expect(buttons(published, false)).toEqual(['localReview.reply']);
  });

  it('offers "Add to Review" first, then "Reply Now", during a review', () => {
    expect(buttons(published, true)).toEqual(['localReview.addToReview', 'localReview.replyNow']);
  });

  it('only offers "Add to Review" on a draft-only thread', () => {
    expect(buttons(draftOnly, true)).toEqual(['localReview.addToReview']);
  });
});

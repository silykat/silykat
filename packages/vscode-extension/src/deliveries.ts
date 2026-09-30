import * as vscode from 'vscode';
import {
  localReviewHome,
  newDeliveryId,
  SessionRegistry,
  subscribersOf,
  topicKey,
  topicLabel,
  topicOf,
  type Session,
  type Topic,
} from '@local-review/core';
import type { Log } from './log';
import type { Publication, ReviewController } from './controller';
import { sessionLabel } from './sessionLabel';

/** Shows a message with actions; resolves to the action picked. Replaceable in tests. */
export type Warner = (message: string, ...actions: string[]) => Thenable<string | undefined>;

/** Asks before publishing comments nobody is subscribed to; resolves to the button picked (`undefined`: cancel). */
export type NoSubscriberPrompt = (
  message: string,
  detail: string,
  ...actions: string[]
) => Thenable<string | undefined>;

const COPY = 'Copy Command';

/** `localReview.pushToAgents`: whether published comments are sent to the agent sessions at all. */
const pushEnabled = () => vscode.workspace.getConfiguration('localReview').get<boolean>('pushToAgents', true);
const PUBLISH = 'Publish';
const PUBLISH_AND_MUTE = "Publish, Don't Warn Again for This Folder";

/**
 * Publishes what the user publishes to the agent sessions subscribed to it: each thread goes to
 * every session subscribed to its branch (or, outside git, its path), through their inboxes (the
 * agent's adapter watches them: for Claude Code, the channel server). It never picks between
 * sessions: what each one does with a comment is up to it.
 */
export class DeliveriesUi implements vscode.Disposable {
  private readonly registry = new SessionRegistry(localReviewHome());
  private readonly subscription: vscode.Disposable;
  private queue: Promise<void> = Promise.resolve();
  /** Sessions already said not to be notifiable: once each, not at every comment. */
  private readonly warned = new Set<string>();
  /** Folders where the user asked not to be warned again about comments nobody gets (until VS Code closes). */
  private readonly muted = new Set<string>();
  warn: Warner = (message, ...actions) => vscode.window.showWarningMessage(message, ...actions);
  askNoSubscriber: NoSubscriberPrompt = (message, detail, ...actions) =>
    vscode.window.showWarningMessage(message, { modal: true, detail }, ...actions);

  constructor(
    private readonly review: ReviewController,
    private readonly log: Log,
  ) {
    // One after the other, in the order of the user's actions (e.g. a comment, then its deletion).
    this.subscription = review.onDidPublish((p) => {
      // Where each thread is now: it may be gone when its turn comes (a comment deleted right away).
      const files: Record<string, string> = {};
      for (const id of p.threadIds) {
        const file = review.threadFile(id);
        if (file) files[id] = file;
      }
      const published = { ...p, files: { ...files, ...p.files } };
      this.queue = this.queue.then(() => this.deliver(published)).then(() => undefined);
    });
    review.publishGate = (root, files) => this.confirmPublish(root, files);
  }

  /**
   * Before publishing: when some of these files have no subscribed session, warns and lets the
   * user cancel. Resolves to whether to publish.
   */
  async confirmPublish(root: string, files: string[]): Promise<boolean> {
    if (!pushEnabled() || this.muted.has(root) || files.length === 0) return true;
    try {
      const sessions = await this.registry.list();
      const orphans: Topic[] = [];
      for (const file of new Set(files)) {
        const topic = await topicOf(file);
        if (subscribersOf(sessions, file, topic).length === 0 && !orphans.some((o) => topicKey(o) === topicKey(topic)))
          orphans.push(topic);
      }
      if (orphans.length === 0) return true;
      const what = files.length === 1 ? 'this comment' : 'these comments';
      const picked = await this.askNoSubscriber(
        `No agent session is subscribed to ${orphans.map(topicLabel).join(', ')}. Publish ${what} anyway?`,
        'They will be saved, but sent to no session: an agent reads them when you ask it (e.g. /local-review:review). ' +
          'A session subscribes by modifying a file there, by being started in that worktree, or when you ask it to.',
        PUBLISH,
        PUBLISH_AND_MUTE,
      );
      if (picked === PUBLISH_AND_MUTE) this.muted.add(root);
      return picked === PUBLISH || picked === PUBLISH_AND_MUTE;
    } catch (err) {
      this.log.error('Failed to check the subscribed sessions', err);
      return true; // never block publishing on our own failure
    }
  }

  /** Delivers a publication to every subscribed session. Resolves to their ids. */
  async deliver(p: Publication): Promise<string[]> {
    if (!pushEnabled()) return []; // the user asks the agents themselves
    try {
      const sessions = await this.registry.list();
      const bySession = new Map<string, { session: Session; threadIds: string[] }>();
      for (const threadId of p.threadIds) {
        const file = this.review.threadFile(threadId) ?? p.files?.[threadId];
        if (!file) continue; // deleted meanwhile
        for (const session of subscribersOf(sessions, file, await topicOf(file))) {
          const entry = bySession.get(session.id) ?? { session, threadIds: [] };
          entry.threadIds.push(threadId);
          bySession.set(session.id, entry);
        }
      }
      const recipients = [...bySession.keys()];
      for (const { session, threadIds } of bySession.values()) {
        await this.registry.deliver(session.id, {
          id: newDeliveryId(),
          at: new Date().toISOString(),
          root: p.root,
          kind: p.kind,
          threadIds,
          ...(p.reviewId ? { reviewId: p.reviewId } : {}),
          recipients,
        });
        this.log.info(`${p.root}: ${p.kind} (${threadIds.length} thread(s)) delivered to session ${session.id}`);
        if (session.push === false) void this.warnNoPush(session);
      }
      return recipients;
    } catch (err) {
      this.log.error('Failed to deliver the comments to the agent sessions', err);
      return [];
    }
  }

  dispose(): void {
    this.subscription.dispose();
  }

  private async warnNoPush(s: Session): Promise<void> {
    if (this.warned.has(s.id)) return;
    this.warned.add(s.id);
    const fix = s.pushCommand ? ` To fix it, relaunch it with: ${s.pushCommand}` : '';
    const picked = await this.warn(
      `Local Review: ${sessionLabel(s)} won't see your comments until you ask it, as its session can't be notified.${fix}`,
      ...(s.pushCommand ? [COPY] : []),
    );
    if (picked === COPY && s.pushCommand) await vscode.env.clipboard.writeText(s.pushCommand);
  }
}

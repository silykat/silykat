import * as vscode from 'vscode';
import { deliveryTarget, localReviewHome, newDeliveryId, SessionRegistry, type Session } from '@local-review/core';
import type { Log } from './log';
import type { Publication, ReviewController } from './controller';

/** Shows a warning with actions; resolves to the action picked. Replaceable in tests. */
export type Warner = (message: string, ...actions: string[]) => Thenable<string | undefined>;

const COPY = 'Copy Command';

/**
 * Hands what the user publishes to the agent session working on that folder, through the session's
 * inbox. The agent's adapter watches it (for Claude Code: the channel server), so that publishing
 * is all the user has to do.
 */
export class DeliveriesUi implements vscode.Disposable {
  private readonly registry = new SessionRegistry(localReviewHome());
  private readonly subscription: vscode.Disposable;
  /** Sessions already told about: warned once per session, not at every comment. */
  private readonly warned = new Set<string>();
  warn: Warner = (message, ...actions) => vscode.window.showWarningMessage(message, ...actions);

  constructor(
    review: ReviewController,
    private readonly log: Log,
  ) {
    this.subscription = review.onDidPublish((p) => void this.deliver(p));
  }

  /** Delivers a publication now. Resolves to the session it went to, if any. */
  async deliver(p: Publication): Promise<Session | undefined> {
    try {
      const target = deliveryTarget(await this.registry.list(), p.root);
      if (!target) {
        this.log.info(`${p.root}: no agent session for ${p.threadIds.length} published thread(s)`);
        return undefined;
      }
      await this.registry.deliver(target.id, {
        id: newDeliveryId(),
        at: new Date().toISOString(),
        root: p.root,
        kind: p.kind,
        threadIds: p.threadIds,
        ...(p.reviewId ? { reviewId: p.reviewId } : {}),
      });
      this.log.info(`${p.root}: ${p.kind} (${p.threadIds.length} thread(s)) delivered to session ${target.id}`);
      if (target.push === false) void this.warnNoPush(target);
      return target;
    } catch (err) {
      this.log.error('Failed to deliver the comments to the agent session', err);
      return undefined;
    }
  }

  dispose(): void {
    this.subscription.dispose();
  }

  private async warnNoPush(s: Session): Promise<void> {
    if (this.warned.has(s.id)) return;
    this.warned.add(s.id);
    const who = `${s.agent}${s.branch ? ` · ${s.branch}` : ''}`;
    const fix = s.pushCommand ? ` To fix it, relaunch it with: ${s.pushCommand}` : '';
    const picked = await this.warn(
      `Local Review: ${who} won't see your comments until you ask it, as its session can't be notified.${fix}`,
      ...(s.pushCommand ? [COPY] : []),
    );
    if (picked === COPY && s.pushCommand) await vscode.env.clipboard.writeText(s.pushCommand);
  }
}

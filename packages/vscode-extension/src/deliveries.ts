import * as vscode from 'vscode';
import {
  DeliveryQueue,
  localReviewHome,
  newDeliveryId,
  planDelivery,
  relevantSessions,
  SessionRegistry,
  type Delivery,
  type Session,
} from '@local-review/core';
import type { Log } from './log';
import type { Publication, ReviewController } from './controller';
import { sessionDetail, sessionLabel } from './sessionLabel';

/** Shows a message with actions; resolves to the action picked. Replaceable in tests. */
export type Warner = (message: string, ...actions: string[]) => Thenable<string | undefined>;

/** A session offered to the user, when it is not clear which one should get some comments. */
export interface SessionChoice {
  session: Session;
  /** Why it is offered, e.g. "proposed". */
  note?: string;
}

/** Asks the user which session gets some comments; resolves to its id (`undefined`: Esc). */
export type SessionPicker = (title: string, choices: SessionChoice[]) => Thenable<string | undefined>;

const COPY = 'Copy Command';
const CHOOSE = 'Send to a Session…';
const LAST_USED_KEY = 'localReview.lastSession';

/**
 * Hands what the user publishes to the agent sessions that should handle it, through their inboxes
 * (the agent's adapter watches them: for Claude Code, the channel server). Each thread goes to the
 * session that wrote its file, else to the one working closest to it; in doubt the user confirms;
 * with no session around, the comments wait for the next one started on their folder.
 */
export class DeliveriesUi implements vscode.Disposable {
  private readonly registry = new SessionRegistry(localReviewHome());
  readonly queue = new DeliveryQueue(localReviewHome());
  private readonly subscription: vscode.Disposable;
  /** Sessions already said not to be notifiable: once each, not at every comment. */
  private readonly warned = new Set<string>();
  /** Sessions when the user last declined to pick one for waiting comments: not asked again until they change. */
  private declinedFor: string | undefined;
  private flushing = false;
  warn: Warner = (message, ...actions) => vscode.window.showWarningMessage(message, ...actions);
  inform: Warner = (message, ...actions) => vscode.window.showInformationMessage(message, ...actions);
  pick: SessionPicker = quickPickSession;

  constructor(
    private readonly review: ReviewController,
    private readonly log: Log,
    private readonly memento: vscode.Memento,
    /** Called when the waiting comments change, to refresh what shows them. */
    private readonly onWaitingChanged: () => void = () => undefined,
  ) {
    this.subscription = review.onDidPublish((p) => void this.deliver(p));
  }

  /** Delivers a publication now. Resolves to the ids of the sessions that got something. */
  async deliver(p: Publication): Promise<string[]> {
    try {
      const sessions = await this.registry.list();
      const alreadyWaiting = (await this.queue.peek(p.root)).length > 0;
      // What waited in that folder goes along, when a session may take it: e.g. comments kept
      // waiting because the question about them was closed by another prompt.
      const along = relevantSessions(sessions, [p.root]).length > 0 ? await this.queue.take(p.root) : [];
      const publication = along.length > 0 ? merge([p, ...along]) : p;
      this.declinedFor = undefined; // a new publication asks again
      const { sent, waiting, declined } = await this.route(sessions, publication);
      if (declined.length > 0) this.declinedFor = signature(sessions);
      if (waiting.length + declined.length > 0)
        await this.queue.add(this.delivery(publication, [...waiting, ...declined]));
      if (along.length > 0 || waiting.length + declined.length > 0) this.onWaitingChanged();
      // Said when comments start to wait there, not for every comment that joins them.
      if (waiting.length > 0 && !alreadyWaiting) void this.sayWaiting(p.root, sessions);
      return sent;
    } catch (err) {
      this.log.error('Failed to deliver the comments to the agent session', err);
      return [];
    }
  }

  /**
   * "Send Waiting Comments": sends what waits in these folders now, asking the user for a session
   * when none is clear, including sessions working elsewhere.
   */
  async sendWaiting(roots: readonly string[]): Promise<void> {
    const sessions = await this.registry.list();
    if (sessions.length === 0) {
      void this.inform(
        'Local Review: no agent session is running. Waiting comments go to the next one started on their folder.',
      );
      return;
    }
    this.declinedFor = undefined;
    for (const root of roots) {
      const pending = await this.queue.take(root);
      if (pending.length === 0) continue;
      const all = merge(pending);
      const { waiting, declined } = await this.route(sessions, all);
      let left = [...waiting, ...declined];
      if (waiting.length > 0 && declined.length === 0) {
        // No session works on that folder: any running one can take them.
        const id = await this.pick(
          `Local Review: no agent session works on ${label(root)}. Which one handles the waiting comments?`,
          sessions.map((session) => ({ session, note: 'works elsewhere' })),
        );
        const session = sessions.find((s) => s.id === id);
        if (session) {
          await this.sendTo(session, all, waiting);
          left = [];
        }
      }
      if (left.length > 0) await this.queue.add(this.delivery(all, left));
    }
    this.onWaitingChanged();
  }

  /** Sends the comments waiting in these folders to sessions that now work on them. */
  async flush(roots: readonly string[]): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const sessions = await this.registry.list();
      if (this.declinedFor === signature(sessions)) return;
      for (const root of roots) {
        if (relevantSessions(sessions, [root]).length === 0) continue; // nobody to send them to yet
        const pending = await this.queue.take(root);
        if (pending.length === 0) continue;
        // All that waited, as one publication: at most one question.
        const all = merge(pending);
        const { waiting, declined } = await this.route(sessions, all);
        if (declined.length > 0) this.declinedFor = signature(sessions);
        const left = [...waiting, ...declined];
        if (left.length > 0) await this.queue.add(this.delivery(all, left));
        this.onWaitingChanged();
      }
    } catch (err) {
      this.log.error('Failed to send the waiting comments', err);
    } finally {
      this.flushing = false;
    }
  }

  /** How many published threads wait for a session, in these folders. */
  async waitingCount(roots: readonly string[]): Promise<number> {
    let n = 0;
    for (const root of roots) n += new Set((await this.queue.peek(root)).flatMap((d) => d.threadIds)).size;
    return n;
  }

  dispose(): void {
    this.subscription.dispose();
  }

  /**
   * Sends each thread of a publication to its session, asking the user when in doubt. Returns the
   * sessions that got something, the threads no session works on, and those the user did not send.
   */
  private async route(
    sessions: Session[],
    p: Publication | Delivery,
  ): Promise<{ sent: string[]; waiting: string[]; declined: string[] }> {
    const threads = p.threadIds.flatMap((id) => {
      const file = this.review.threadFile(id);
      return file ? [{ id, file }] : []; // a thread deleted meanwhile has nothing left to send
    });
    const plan = planDelivery(
      sessions,
      p.root,
      threads,
      this.memento.get<Record<string, string>>(LAST_USED_KEY)?.[p.root],
    );
    const sent: string[] = [];
    const declined: string[] = [];
    const send = async (session: Session, threadIds: string[]) => {
      await this.sendTo(session, p, threadIds);
      sent.push(session.id);
    };
    for (const [id, threadIds] of plan.sure)
      await send(
        sessions.find((s) => s.id === id)!,
        threadIds,
      );
    if (plan.doubt) {
      const { threadIds, proposed, candidates } = plan.doubt;
      const picked = await this.ask(p.root, threadIds.length, proposed, candidates, sessions);
      if (picked) await send(picked, threadIds);
      else declined.push(...threadIds);
    }
    return { sent, waiting: plan.waiting, declined };
  }

  private async sendTo(session: Session, p: Publication | Delivery, threadIds: string[]): Promise<void> {
    await this.registry.deliver(session.id, this.delivery(p, threadIds));
    await this.remember(p.root, session.id);
    this.log.info(`${p.root}: ${p.kind} (${threadIds.length} thread(s)) delivered to session ${session.id}`);
    if (session.push === false) void this.warnNoPush(session);
  }

  private delivery(p: Publication | Delivery, threadIds: string[]): Delivery {
    return {
      id: newDeliveryId(),
      at: new Date().toISOString(),
      root: p.root,
      kind: p.kind,
      threadIds,
      ...(p.reviewId ? { reviewId: p.reviewId } : {}),
    };
  }

  private async ask(
    root: string,
    count: number,
    proposed: Session,
    candidates: Session[],
    all: Session[],
  ): Promise<Session | undefined> {
    const others = all.filter((s) => !candidates.some((c) => c.id === s.id));
    const choices: SessionChoice[] = [
      { session: proposed, note: 'proposed' },
      ...candidates.filter((c) => c.id !== proposed.id).map((session) => ({ session })),
      ...others.map((session) => ({ session, note: 'works elsewhere' })),
    ];
    const what = count === 1 ? 'this comment' : `these ${count} comments`;
    const id = await this.pick(
      `Local Review: several agent sessions work on ${label(root)}. Which one handles ${what}?`,
      choices,
    );
    return all.find((s) => s.id === id);
  }

  private async remember(root: string, sessionId: string): Promise<void> {
    const lastUsed = this.memento.get<Record<string, string>>(LAST_USED_KEY) ?? {};
    if (lastUsed[root] !== sessionId) await this.memento.update(LAST_USED_KEY, { ...lastUsed, [root]: sessionId });
  }

  private async sayWaiting(root: string, sessions: Session[]): Promise<void> {
    const picked = await this.inform(
      `Local Review: no agent session works on ${label(root)}. Your comments will go to the next one started there.`,
      ...(sessions.length > 0 ? [CHOOSE] : []),
    );
    if (picked === CHOOSE) await this.sendWaiting([root]);
  }

  private async warnNoPush(s: Session): Promise<void> {
    if (this.warned.has(s.id)) return;
    this.warned.add(s.id);
    const who = sessionLabel(s);
    const fix = s.pushCommand ? ` To fix it, relaunch it with: ${s.pushCommand}` : '';
    const picked = await this.warn(
      `Local Review: ${who} won't see your comments until you ask it, as its session can't be notified.${fix}`,
      ...(s.pushCommand ? [COPY] : []),
    );
    if (picked === COPY && s.pushCommand) await vscode.env.clipboard.writeText(s.pushCommand);
  }
}

/** Several publications of a folder as one: their threads, as a review if one of them was. */
function merge(ps: (Publication | Delivery)[]): Publication {
  const review = ps.find((p) => p.kind === 'review');
  const first = review ?? ps[0]!;
  return {
    root: first.root,
    kind: first.kind,
    threadIds: [...new Set(ps.flatMap((p) => p.threadIds))],
    ...(first.reviewId ? { reviewId: first.reviewId } : {}),
  };
}

const signature = (sessions: Session[]) => sessions.map((s) => s.id).join(' ');

/** A folder as the user knows it: its name in the workspace. */
function label(root: string): string {
  const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.fsPath === root);
  return folder ? folder.name : root;
}

async function quickPickSession(title: string, choices: SessionChoice[]): Promise<string | undefined> {
  const picked = await vscode.window.showQuickPick(
    choices.map(({ session: s, note }) => ({
      label: `$(hubot) ${sessionLabel(s)}`,
      description: note,
      detail: sessionDetail(s),
      id: s.id,
    })),
    {
      title,
      placeHolder: 'Enter sends to the proposed session · Esc keeps the comments waiting',
      ignoreFocusOut: true,
    },
  );
  return picked?.id;
}

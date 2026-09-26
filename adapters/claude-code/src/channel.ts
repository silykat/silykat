import type { Delivery, InboxCursor, Session, SessionRegistry } from '@local-review/core';

// The Local Review channel: an MCP server that Claude Code starts with each session. It watches
// that session's inbox and pushes what the user publishes into the session, which wakes Claude up
// even while it waits for the user. Channels are specific to Claude Code (research preview).

/** A JSON-RPC message, as exchanged with Claude Code over stdio (one per line). */
export interface RpcMessage {
  jsonrpc?: '2.0';
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface ChannelDeps {
  registry: Pick<SessionRegistry, 'list' | 'readInbox'>;
  /** The Claude Code process that started this server: its session is the one we serve. */
  claudePid: number | null;
  send(message: RpcMessage): void;
  now(): number;
  version: string;
}

/** Publications closer together than this go to Claude as one message. */
export const BATCH_MS = 1500;

const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export const INSTRUCTIONS = [
  'Local Review is the local code review tool the user works with in VS Code.',
  'When the user publishes comments there, they arrive as <channel source="...local-review..." store="<folder>" threads="<ids>">.',
  'Process them right away, without waiting to be asked: follow the local-review review skill',
  '(/local-review:review), passing `--root <folder>` (the store attribute) to every `lr` command, and listing only',
  'those threads (`lr list --root <folder> --thread <id> --thread <id>…`): others may be for another session.',
  'Answer in the threads with `lr reply`; nothing needs to be sent back through the channel.',
].join(' ');

export class LocalReviewChannel {
  private ready = false;
  private sessionId: string | undefined;
  private cursor: InboxCursor | undefined;
  private readonly seen = new Set<string>();
  private pending: Delivery[] = [];
  private lastArrival = 0;

  constructor(private readonly deps: ChannelDeps) {}

  /** A message from Claude Code. */
  handle(message: RpcMessage): void {
    if (message.method === undefined) return; // a response: we send no request
    const isRequest = message.id !== undefined && message.id !== null;
    switch (message.method) {
      case 'initialize': {
        const requested = message.params?.protocolVersion;
        this.respond(message, {
          protocolVersion:
            typeof requested === 'string' && SUPPORTED_PROTOCOLS.includes(requested)
              ? requested
              : SUPPORTED_PROTOCOLS[0],
          capabilities: { experimental: { 'claude/channel': {} } },
          serverInfo: { name: 'local-review', version: this.deps.version },
          instructions: INSTRUCTIONS,
        });
        return;
      }
      case 'notifications/initialized':
        this.ready = true;
        return;
      case 'ping':
        this.respond(message, {});
        return;
      default:
        if (isRequest)
          this.deps.send({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: `Method not found: ${message.method}` },
          });
    }
  }

  /** One look at the inbox; called regularly. Pushes a batch once publications have settled. */
  async poll(): Promise<void> {
    if (!this.ready) return;
    const session = await this.currentSession();
    if (session && session.id !== this.sessionId) {
      // A new session in the same process (e.g. after /clear): its inbox starts afresh.
      this.sessionId = session.id;
      this.cursor = undefined;
    }
    if (this.sessionId) {
      const { deliveries, cursor } = await this.deps.registry.readInbox(this.sessionId, this.cursor);
      this.cursor = cursor;
      const fresh = deliveries.filter((d) => !this.seen.has(d.id));
      for (const d of fresh) this.seen.add(d.id);
      if (fresh.length > 0) {
        this.pending.push(...fresh);
        this.lastArrival = this.deps.now();
      }
    }
    if (this.pending.length > 0 && this.deps.now() - this.lastArrival >= BATCH_MS) this.flush();
  }

  private async currentSession(): Promise<Session | undefined> {
    if (this.deps.claudePid === null) return undefined;
    const mine = (await this.deps.registry.list()).filter((s) => s.pid === this.deps.claudePid);
    return mine.reduce<Session | undefined>(
      (a, s) => (a === undefined || s.startedAt > a.startedAt ? s : a),
      undefined,
    );
  }

  private flush(): void {
    const byRoot = new Map<string, Delivery[]>();
    for (const d of this.pending) byRoot.set(d.root, [...(byRoot.get(d.root) ?? []), d]);
    this.pending = [];
    for (const [root, deliveries] of byRoot) {
      this.deps.send({
        jsonrpc: '2.0',
        method: 'notifications/claude/channel',
        params: {
          content: describe(root, deliveries),
          meta: { store: root, threads: threadIds(deliveries).join(' ') },
        },
      });
    }
  }

  private respond(request: RpcMessage, result: unknown): void {
    if (request.id === undefined || request.id === null) return;
    this.deps.send({ jsonrpc: '2.0', id: request.id, result });
  }
}

/** What Claude reads, e.g. "The user published a review (3 threads) in Local Review, in /repo. …" */
export function describe(root: string, deliveries: Delivery[]): string {
  const ids = threadIds(deliveries);
  const threads = ids.length;
  const reviews = deliveries.filter((d) => d.kind === 'review').length;
  const comments = deliveries.filter((d) => d.kind === 'comment').length;
  const replies = deliveries.filter((d) => d.kind === 'reply').length;
  const what = [count(reviews, 'review'), count(comments, 'new comment'), count(replies, 'reply', 'replies')].filter(
    (s) => s !== '',
  );
  return (
    `The user published ${joinList(what)} in Local Review (${count(threads, 'thread')}), in ${root}. ` +
    `Process them now with the local-review review skill, running every lr command with --root ${JSON.stringify(root)}, ` +
    `and listing only these threads: lr list --root ${JSON.stringify(root)} ${ids.map((id) => `--thread ${id}`).join(' ')}`
  );
}

/** The threads of some deliveries, each once. */
export const threadIds = (deliveries: Delivery[]): string[] => [...new Set(deliveries.flatMap((d) => d.threadIds))];

const count = (n: number, one: string, many = `${one}s`) =>
  n === 0 ? '' : n === 1 && one === 'review' ? 'a review' : `${n} ${n === 1 ? one : many}`;

const joinList = (parts: string[]) =>
  parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;

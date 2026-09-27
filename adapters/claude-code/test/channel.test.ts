import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionRegistry, type Delivery, type SessionRecord } from '@local-review/core';
import { BATCH_MS, describe as describeDeliveries, LocalReviewChannel, type RpcMessage } from '../src/channel';
import { hasChannel, LAUNCH_WITH_CHANNEL } from '../src/channelFlag';

let home: string;
let registry: SessionRegistry;
let sent: RpcMessage[];
let now: number;

const session = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  id: 's1',
  agent: 'Claude',
  cwd: '/repo',
  branch: 'main',
  pid: 4242,
  startedAt: '2026-09-26T10:00:00.000Z',
  ...over,
});
let n = 0;
const delivery = (over: Partial<Delivery> = {}): Delivery => ({
  id: `d_${++n}`,
  at: '2026-09-26T10:00:00.000Z',
  root: '/repo',
  kind: 'comment',
  threadIds: [`t_${n}`],
  ...over,
});

function channel(claudePid: number | null = 4242): LocalReviewChannel {
  const c = new LocalReviewChannel({
    registry,
    claudePid,
    send: (m) => sent.push(m),
    now: () => now,
    version: '1.2.3',
  });
  c.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  c.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  sent = [];
  return c;
}
const pushed = () => sent.filter((m) => m.method === 'notifications/claude/channel').map((m) => m.params);

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'lr-channel-'));
  registry = new SessionRegistry(home, () => true);
  sent = [];
  now = 1_000_000;
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('The channel server', () => {
  it('declares itself a Claude Code channel, with instructions for Claude', () => {
    const c = new LocalReviewChannel({
      registry,
      claudePid: 1,
      send: (m) => sent.push(m),
      now: () => now,
      version: '1.2.3',
    });
    c.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    c.handle({ jsonrpc: '2.0', id: 2, method: 'ping' });
    c.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    expect(sent[0]).toMatchObject({
      id: 1,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { experimental: { 'claude/channel': {} } },
        serverInfo: { name: 'local-review', version: '1.2.3' },
      },
    });
    expect((sent[0]!.result as { instructions: string }).instructions).toContain('--root <folder>');
    expect(sent[1]).toEqual({ jsonrpc: '2.0', id: 2, result: {} });
    expect(sent[2]).toMatchObject({ id: 3, error: { code: -32601 } });
  });

  it('pushes what is published for its session once publications settle, grouped', async () => {
    await registry.register(session());
    await registry.register(session({ id: 'other', pid: 999 }));
    const c = channel();
    const first = delivery();
    await registry.deliver('s1', first);
    await registry.deliver('other', delivery());
    await c.poll();
    expect(pushed()).toEqual([]); // more may follow
    now += 500;
    await registry.deliver('s1', delivery({ kind: 'review', threadIds: ['t_a', 't_b'], reviewId: 'r_1' }));
    await c.poll();
    now += BATCH_MS;
    await c.poll();
    expect(pushed()).toEqual([
      {
        content:
          'The user published a review and 1 new comment in Local Review (3 threads), in /repo. ' +
          'Process them now with the local-review review skill, running every lr command with --root "/repo", ' +
          `and listing only these threads: lr list --root "/repo" --thread ${first.threadIds[0]} --thread t_a --thread t_b`,
        meta: { store: '/repo', threads: `${first.threadIds[0]} t_a t_b`, recipients: '' },
      },
    ]);
    now += BATCH_MS;
    await c.poll();
    expect(pushed()).toHaveLength(1); // never twice
  });

  it('pushes one message per store', async () => {
    await registry.register(session());
    const c = channel();
    await registry.deliver('s1', delivery({ root: '/repo' }));
    await registry.deliver('s1', delivery({ root: '/specs', kind: 'reply' }));
    await c.poll();
    now += BATCH_MS;
    await c.poll();
    expect(pushed().map((p) => (p as { meta: { store: string } }).meta.store)).toEqual(['/repo', '/specs']);
  });

  it('pushes nothing before Claude Code is ready, then what arrived meanwhile', async () => {
    await registry.register(session());
    await registry.deliver('s1', delivery());
    const c = new LocalReviewChannel({
      registry,
      claudePid: 4242,
      send: (m) => sent.push(m),
      now: () => now,
      version: '1',
    });
    await c.poll();
    now += BATCH_MS;
    await c.poll();
    expect(sent).toEqual([]);
    c.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await c.poll();
    now += BATCH_MS;
    await c.poll();
    expect(pushed()).toHaveLength(1);
  });

  it('follows the new session of its process (e.g. after /clear)', async () => {
    await registry.register(session());
    const c = channel();
    await c.poll();
    await registry.unregister('s1');
    await registry.register(session({ id: 's2', startedAt: '2026-09-26T11:00:00.000Z' }));
    await registry.deliver('s2', delivery());
    await c.poll();
    now += BATCH_MS;
    await c.poll();
    expect(pushed()).toHaveLength(1);
  });

  it('waits for its session to register', async () => {
    const c = channel();
    await c.poll();
    await registry.register(session());
    await registry.deliver('s1', delivery());
    await c.poll();
    now += BATCH_MS;
    await c.poll();
    expect(pushed()).toHaveLength(1);
  });
});

describe('describe', () => {
  it('says what was published', () => {
    expect(describeDeliveries('/r', [delivery({ threadIds: ['t_x'] })])).toMatch(
      /^The user published 1 new comment in Local Review \(1 thread\), in \/r\./,
    );
    expect(describeDeliveries('/r', [delivery({ kind: 'reply' }), delivery({ kind: 'reply' })])).toMatch(
      /published 2 replies .*\(2 threads\)/,
    );
  });
});

describe('hasChannel', () => {
  it('tells whether Claude Code was launched with the Local Review channel', () => {
    expect(hasChannel(LAUNCH_WITH_CHANNEL)).toBe(true);
    expect(hasChannel('/opt/claude --dangerously-load-development-channels=plugin:local-review@local-review')).toBe(
      true,
    );
    expect(
      hasChannel('claude --channels plugin:telegram@claude-plugins-official plugin:local-review@mine --resume'),
    ).toBe(true);
    expect(hasChannel('claude')).toBe(false);
    expect(hasChannel('claude --dangerously-load-development-channels server:webhook')).toBe(false);
    expect(hasChannel('claude --resume plugin:local-review@local-review')).toBe(false);
  });
});

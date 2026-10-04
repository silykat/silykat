import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { watchStore } from '../../src/watcher';

const THREAD = 't_01M3N16PWKVMZERC9JQPN2KJE3';

let root: string;
let store: string;
let seen: string[];
let watcher: { dispose(): void } | undefined;

const write = (threadId = THREAD) => {
  mkdirSync(join(store, 'threads'), { recursive: true });
  mkdirSync(join(store, 'reviews'), { recursive: true });
  appendFileSync(join(store, 'threads', `${threadId}.jsonl`), '{}\n');
};
const start = () => {
  watcher = watchStore(store, { onThread: (id) => seen.push(id), onReviews: () => seen.push('reviews') });
};
const seenThread = async () => {
  for (let i = 0; i < 250 && !seen.includes(THREAD); i++) await new Promise((r) => setTimeout(r, 20));
  return seen.includes(THREAD);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lr-watch-'));
  store = join(root, '.local-review');
  seen = [];
});

afterEach(() => {
  watcher?.dispose();
  rmSync(root, { recursive: true, force: true });
});

describe('watchStore', () => {
  it('reports a journal written by another process', async () => {
    write('t_01M3N11R6T6FGRBA67E69JRDSC');
    start();
    write();
    expect(await seenThread()).toBe(true);
  });

  it('waits for a store that does not exist yet', async () => {
    start();
    write();
    expect(await seenThread()).toBe(true);
  });

  it('follows a store removed and created again right away', async () => {
    write('t_01M3N11R6T6FGRBA67E69JRDSC');
    start();
    rmSync(store, { recursive: true, force: true });
    write();
    expect(await seenThread()).toBe(true);
  });

  it('reads the journals written while its watches start, then follows the new ones', async () => {
    const old = 't_01M3N11R6T6FGRBA67E69JRDSC';
    write(old);
    start();
    // Past the settling delay: the journals already there are read once the watches are active.
    await new Promise((r) => setTimeout(r, 800));
    expect(seen).toContain(old);
    write();
    expect(await seenThread()).toBe(true);
  });

  it('stops when disposed', async () => {
    write('t_01M3N11R6T6FGRBA67E69JRDSC');
    start();
    watcher!.dispose();
    write();
    await new Promise((r) => setTimeout(r, 300));
    expect(seen).toEqual([]);
  });
});

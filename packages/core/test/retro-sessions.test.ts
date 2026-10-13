import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  analysisInput,
  defaultExcerpt,
  excerptOf,
  readRetroSessions,
  recordRetroSessions,
  RetroBook,
  SESSIONS_FILE,
  summaryText,
  type RetroSession,
} from '../src/index';

let base: string;
beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'slk-retro-sessions-')));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const session = (id: string, summary: Record<string, unknown> | null): RetroSession => ({
  id,
  start: '2026-09-20T10:00:00.000Z',
  folder: '/work',
  facts: { user_interruptions: 2, first_prompt: 'Fix the tests' },
  summary,
});

describe("the agent's sessions of a retro", () => {
  it('are written in the retro, listed in its journal with what reading them cost, and read back', async () => {
    const book = new RetroBook(base);
    const r = await book.start({
      root: base,
      since: null,
      until: '2026-09-30T00:00:00.000Z',
      stores: [],
      threads: [],
      bytes: 0,
    });
    expect(r.sessions).toBeNull();
    const file = await recordRetroSessions(
      book,
      r.id,
      'Claude Code /insights',
      [
        session('s1', { brief_summary: 'Fixed the tests', friction_counts: { wrong_approach: 1 } }),
        session('s2', null),
      ],
      { costUsd: 0.7, durationMs: 53_000 },
    );
    expect(file).toBe(join(base, '.silykat', 'retros', r.id, SESSIONS_FILE));
    expect((await book.get(r.id)).sessions).toEqual({
      source: 'Claude Code /insights',
      list: [
        { id: 's1', start: '2026-09-20T10:00:00.000Z', summary: true },
        { id: 's2', start: '2026-09-20T10:00:00.000Z', summary: false },
      ],
      costUsd: 0.7,
      durationMs: 53_000,
    });
    expect((await readRetroSessions(book, r.id)).map((s) => s.id)).toEqual(['s1', 's2']);

    // Recorded again (a second run): the last list counts; without its cost when unknown.
    await recordRetroSessions(book, r.id, 'Claude Code /insights', [session('s1', null)]);
    expect((await book.get(r.id)).sessions).toMatchObject({ list: [{ id: 's1' }], costUsd: null, durationMs: null });

    await writeFile(file, '{"sessions": [{"id": 1}, {"id": "ok", "start": "x"}]}');
    expect((await readRetroSessions(book, r.id)).map((s) => s.id)).toEqual(['ok']);
    await writeFile(file, 'not json');
    expect(await readRetroSessions(book, r.id)).toEqual([]);
    expect(
      JSON.parse(
        await readFile(join(base, '.silykat', 'retros', `${r.id}.jsonl`), 'utf8').then((t) => t.split('\n')[1]!),
      ),
    ).toMatchObject({
      v: 1,
      type: 'retro.sessions',
    });
  });

  it('are given to the analysis, with their facts and summary', async () => {
    const book = new RetroBook(base);
    const r = await book.start({
      root: base,
      since: null,
      until: '2026-09-30T00:00:00.000Z',
      stores: [],
      threads: [],
      bytes: 0,
    });
    const text = analysisInput({
      retro: r,
      threads: new Map(),
      previous: [],
      preferences: [],
      sessions: [session('s1', { brief_summary: 'Fixed the tests' }), session('s2', null)],
    });
    expect(text).toContain("## The agent's sessions in this project (2, 1 with a summary written by a model)");
    expect(text).toContain('### Session s1 · 2026-09-20T10:00:00.000Z · /work');
    expect(text).toContain('Facts: user_interruptions: 2 · first_prompt: Fix the tests');
    expect(text).toContain('"brief_summary": "Fixed the tests"');
    expect(text).toContain('No summary.');
    expect(analysisInput({ retro: r, threads: new Map(), previous: [], preferences: [] })).not.toContain(
      'sessions in this project',
    );
  });

  it('are quoted word for word from their summary', () => {
    const text = summaryText({ a: 'The user rejected the first fix.', b: ['x', { c: 'nested words' }], n: 3 });
    expect(text).toBe('The user rejected the first fix.\nx\nnested words');
    expect(excerptOf('"rejected the  first fix…"', text)).toBe(true);
    expect(excerptOf('rejected the first fix...', text)).toBe(true);
    expect(excerptOf('nested words', text)).toBe(true);
    expect(excerptOf('the user was happy', text)).toBe(false);
    expect(excerptOf('…', text)).toBe(false);
    expect(summaryText(null)).toBe('');
    expect(defaultExcerpt({ brief_summary: ' Short. ', friction_detail: '' })).toBe('Short.');
    expect(defaultExcerpt({ underlying_goal: 'Goal' })).toBe('Goal');
    expect(defaultExcerpt(null)).toBe('');
  });
});

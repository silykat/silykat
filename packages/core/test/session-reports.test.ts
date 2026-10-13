import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  citedMoments,
  readSessionReport,
  renderSessionReports,
  reportMoments,
  reportsDir,
  reportText,
  RetroBook,
  sessionReportIds,
  writeSessionReport,
  type SessionReport,
} from '../src';

let base: string;
let book: RetroBook;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'slk-session-reports-')));
  book = new RetroBook(base);
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const report = (session: string, over: Partial<SessionReport> = {}): SessionReport => ({
  v: 1,
  session,
  agent: 'Claude Code',
  folder: base,
  start: '2026-09-22T10:00:00.000Z',
  end: '2026-09-22T11:00:00.000Z',
  covered: { lines: 40 },
  generatedAt: '2026-09-23T10:00:00.000Z',
  model: 'opus',
  run: { costUsd: 0.42, durationMs: 96_000, tokens: 163_000 },
  checks: { citedMoments: 2, unknownMoments: [] },
  analysis: {
    session_id: session,
    summary: 'Fixed the dates.',
    signals: {
      collaboration: {
        corrections: {
          occurrences: 2,
          relevant: [{ uuid: 'u1', verdict: 'Asked for UTC' }],
          not_relevant: [{ uuid: 'u2', reason: 'approval' }],
        },
        friction: { occurrences: 0, relevant: [], not_relevant: [] },
      },
    },
    patterns: [{ name: 'Dates', evidence: ['u3'] }],
  },
  analytics: {
    counts: { typed_prompts: 5 },
    agents: [{ id: 'main' }, { id: 'a1' }],
    signals: { tools: { tool_errors: [{ uuid: 'u4' }] } },
  },
  ...over,
});

describe("the reports on the agent's sessions", () => {
  it('are kept per project, next to the retros, and read back', async () => {
    const file = await writeSessionReport(book, report('s1'));
    expect(file).toBe(join(base, '.silykat', 'retros', 'sessions', 's1.json'));
    expect(reportsDir(book)).toBe(join(base, '.silykat', 'retros', 'sessions'));
    expect(await readSessionReport(book, 's1')).toEqual(report('s1'));
    await writeSessionReport(book, report('s1', { covered: { lines: 80 } }));
    expect((await readSessionReport(book, 's1'))?.covered.lines).toBe(80);
    await writeSessionReport(book, report('s0'));
    expect(await sessionReportIds(book)).toEqual(['s0', 's1']);
  });

  it('reads nothing from a missing, unreadable or foreign file', async () => {
    expect(await readSessionReport(book, 'none')).toBeNull();
    expect(await sessionReportIds(book)).toEqual([]);
    await mkdir(reportsDir(book), { recursive: true });
    await writeFile(join(reportsDir(book), 'bad.json'), '{not json');
    await writeFile(join(reportsDir(book), 'other.json'), JSON.stringify(report('someone-else')));
    await writeFile(join(reportsDir(book), 'half.json'), JSON.stringify({ ...report('half'), analysis: null }));
    expect(await readSessionReport(book, 'bad')).toBeNull();
    expect(await readSessionReport(book, 'other')).toBeNull();
    expect(await readSessionReport(book, 'half')).toBeNull();
  });

  it('refuses a session id that would leave the folder', async () => {
    await expect(writeSessionReport(book, report('../x'))).rejects.toThrow('Invalid session id');
    await expect(writeSessionReport(book, report('.hidden'))).rejects.toThrow('Invalid session id');
    expect(await readSessionReport(book, '../x')).toBeNull();
  });

  it('knows the moments and the words of a report', () => {
    const r = report('s1');
    expect([...citedMoments(r.analysis)].sort()).toEqual(['u1', 'u2', 'u3']);
    expect([...reportMoments(r)].sort()).toEqual(['u1', 'u2', 'u3', 'u4']);
    expect(reportText(r)).toContain('Asked for UTC');
    expect(reportText(r)).toContain('Fixed the dates.');
  });

  it('are given to the analysis without the signals judged not relevant', async () => {
    expect(renderSessionReports([], '/x')).toEqual([]);
    const text = renderSessionReports([report('s1')], '/reports').join('\n');
    expect(text).toContain("## Reports on the agent's sessions (1)");
    expect(text).toContain('(/reports/<session>.json)');
    expect(text).toContain('### Session s1 · 2026-09-22T10:00:00.000Z to 2026-09-22T11:00:00.000Z');
    expect(text).toContain('5 prompts typed by the user · 2 agent(s)');
    expect(text).toContain('"collaboration.corrections"');
    expect(text).toContain('Asked for UTC');
    expect(text).not.toContain('approval');
    expect(text).not.toContain('collaboration.friction');
  });

  it('are listed in the journal of a retro, the last listing counting', async () => {
    const r = await book.start({
      root: base,
      since: null,
      until: '2026-10-01T00:00:00.000Z',
      stores: [],
      threads: [],
      bytes: 0,
    });
    expect(r.reports).toBeNull();
    await book.record(r.id, [
      { type: 'retro.reports', source: 'x', sessions: [{ id: 's1', start: 'a', status: 'failed', reason: 'boom' }] },
      {
        type: 'retro.reports',
        source: 'Claude Code session records',
        sessions: [{ id: 's1', start: 'a', status: 'analysed' }],
        costUsd: 0.4,
        durationMs: 1000,
        tokens: 10,
      },
    ]);
    expect((await book.get(r.id)).reports).toEqual({
      source: 'Claude Code session records',
      list: [{ id: 's1', start: 'a', status: 'analysed' }],
      costUsd: 0.4,
      durationMs: 1000,
      tokens: 10,
    });
    // Run again: what each run took adds up.
    await book.record(r.id, [
      { type: 'retro.reports', source: 'Claude Code session records', sessions: [], costUsd: 0.1, durationMs: 500 },
    ]);
    expect((await book.get(r.id)).reports).toMatchObject({ list: [], costUsd: 0.5, durationMs: 1500, tokens: 10 });
    const journal = await readFile(book.retroFile(r.id), 'utf8');
    expect(journal).toContain('"type":"retro.reports"');
  });
});

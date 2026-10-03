import { describe, expect, it } from 'vitest';
import { DEFAULT_CADENCE, type RetroCadence } from '@local-review/core';
import { retroReminderMessage, retroStatusText, retroTooltip, shownCadence, validFor } from '../../src/retroStatus';

const cadence = (over: Partial<RetroCadence> = {}): RetroCadence => ({
  root: '/work/api',
  lastRetro: { id: 'rt_1', root: '/work', until: '2026-09-27T10:00:00.000Z' },
  since: '2026-09-27T10:00:00.000Z',
  days: 6,
  threads: 30,
  bytes: 640_000,
  thresholds: DEFAULT_CADENCE,
  due: false,
  reasons: [],
  ...over,
});
const name = (c: RetroCadence) => c.root.split('/').at(-1)!;

describe('retro reminder in the status bar', () => {
  it('shows the days and size since the last retro, and says when one is due', () => {
    expect(retroStatusText(cadence(), 'always')).toBe('$(history) Retro: 6 d · 640.0 KB');
    const due = cadence({ days: 8, bytes: 1_200_000, due: true, reasons: ['days', 'size'] });
    expect(retroStatusText(due, 'always')).toBe('$(bell-dot) Retro due: 8 d · 1.2 MB');
    expect(retroStatusText(cadence(), 'whenDue')).toBeUndefined();
    expect(retroStatusText(due, 'whenDue')).toBe('$(bell-dot) Retro due: 8 d · 1.2 MB');
    expect(retroStatusText(due, 'never')).toBeUndefined();
    expect(retroStatusText(undefined, 'always')).toBeUndefined();
  });

  it('shows the folder most due, else the closest to its reminder, never one with nothing new', () => {
    const near = cadence({ root: '/work/web', days: 6 });
    const far = cadence({ root: '/work/api', days: 2, bytes: 100_000 });
    const quiet = cadence({ root: '/work/doc', days: 40, threads: 0, bytes: 0 });
    expect(shownCadence([far, near, quiet])!.root).toBe('/work/web');
    const due = cadence({ root: '/work/ops', days: 1, due: true, reasons: ['size'] });
    expect(shownCadence([near, due])!.root).toBe('/work/ops');
    expect(shownCadence([quiet])).toBeUndefined();
    expect(retroTooltip([near, quiet, due], name)).toBe(
      [
        '**Local Review: retro**',
        '$(history) web: 6 days and 640.0 KB of review threads (30) since the last retro (2026-09-27)',
        '$(bell-dot) **due** ops: 1 day and 640.0 KB of review threads (30) since the last retro (2026-09-27)',
        'Click to see how to run a retro.',
      ].join('\n\n'),
    );
  });

  it('explains how to run a retro', () => {
    const due = cadence({ days: 8, due: true, reasons: ['days'] });
    const message = retroReminderMessage(due, DEFAULT_CADENCE, name);
    expect(message).toMatch(
      /^Local Review: a retro is due for api: 8 days and 640\.0 KB .* \(8 days since the last retro \(reminder at 7\)\)\. A retro looks back/,
    );
    expect(message).toContain(
      'To run it with Claude Code: /local-review:retro, in a session started in the project folder.',
    );
    expect(retroReminderMessage(cadence(), DEFAULT_CADENCE, name)).toContain(
      'no retro due yet for api: 6 days and 640.0 KB of review threads (30) since the last retro (2026-09-27). Reminder at 7 days, or sooner at 1.0 MB of threads.',
    );
    expect(retroReminderMessage(undefined, { days: 30, bytes: 2_000_000, maxDays: 25 }, name)).toBe(
      'Local Review: nothing to look back at since the last retro. Reminder at 25 days, or sooner at 2.0 MB of threads.',
    );
  });

  it('mirrors only values that fit the machine settings', () => {
    expect(validFor('retroReminderDays', 3)).toBe(true);
    expect(validFor('retroReminderDays', 0)).toBe(false);
    expect(validFor('retroReminderDays', 1.5)).toBe(false);
    expect(validFor('retroReminder', false)).toBe(true);
    expect(validFor('retroReminder', 1)).toBe(false);
  });
});

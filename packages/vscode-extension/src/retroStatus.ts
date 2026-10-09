import {
  cadenceSummary,
  DEFAULT_CONFIG,
  dueReasons,
  formatBytes,
  validSettingNumber,
  type CadenceThresholds,
  type MachineConfig,
  type RetroCadence,
} from '@local-review/core';

// Pure (no `vscode` import) so that the retro reminder's texts and choices can be unit-tested.

export const RETRO_COMMAND = '/local-review:retro';

export type StatusBarMode = 'always' | 'whenDue' | 'never';

/**
 * The reminder settings of the extension that the agent hooks need too: they run outside the editor,
 * so the extension mirrors them in the machine settings (`lr config`).
 */
export const MIRRORED: Readonly<Record<string, keyof MachineConfig>> = {
  days: 'retroReminderDays',
  sizeKB: 'retroReminderSizeKB',
  maxDays: 'retroReminderMaxDays',
  agentMessage: 'retroReminder',
};

/** Whether a value fits a machine setting: a boolean, or a whole number of 1 or more. */
export function validFor(name: keyof MachineConfig, value: unknown): value is number | boolean {
  return typeof DEFAULT_CONFIG[name] === 'boolean' ? typeof value === 'boolean' : validSettingNumber(value);
}

/** The folder to show: the one most due, else the one closest to its reminder; none with nothing new. */
export function shownCadence(cadences: readonly RetroCadence[]): RetroCadence | undefined {
  const ratio = (c: RetroCadence) =>
    Math.max(c.days / Math.min(c.thresholds.days, c.thresholds.maxDays), c.bytes / c.thresholds.bytes);
  return [...cadences]
    .filter((c) => c.threads > 0)
    .sort((a, b) => Number(b.due) - Number(a.due) || ratio(b) - ratio(a))[0];
}

/** The status bar text, `undefined` when hidden: "Retro: 6 d · 640.0 KB", or "Retro due: …". */
export function retroStatusText(c: RetroCadence | undefined, mode: StatusBarMode): string | undefined {
  if (!c || mode === 'never' || (mode === 'whenDue' && !c.due)) return undefined;
  const figures = `${c.days} d · ${formatBytes(c.bytes)}`;
  return c.due ? `$(bell-dot) Retro due: ${figures}` : `$(history) Retro: ${figures}`;
}

/** The tooltip lines: one per folder with something new. */
export function retroTooltip(cadences: readonly RetroCadence[], name: (c: RetroCadence) => string): string {
  return [
    '**Local Review: retro**',
    ...cadences
      .filter((c) => c.threads > 0)
      .map((c) => `${c.due ? '$(bell-dot) **due**' : '$(history)'} ${name(c)}: ${cadenceSummary(c)}`),
    'Click to see how to run a retro.',
  ].join('\n\n');
}

/** What a click on the reminder says: where things stand, and how to run a retro. */
export function retroReminderMessage(
  c: RetroCadence | undefined,
  thresholds: CadenceThresholds,
  name: (c: RetroCadence) => string,
): string {
  const t = c?.thresholds ?? thresholds;
  const settings = `Reminder at ${Math.min(t.days, t.maxDays)} days, or sooner at ${formatBytes(t.bytes)} of threads.`;
  const how =
    'A retro looks back at your work with your agent (your review comments, your sessions with it), to improve its setup together (rules, skills, hooks).' +
    ` To run it with Claude Code: ${RETRO_COMMAND}, in a session started in the project folder.` +
    ' With another agent, ask it for a retro: it runs the `lr retro` commands.';
  if (!c) return `Local Review: nothing to look back at since the last retro. ${settings}`;
  return c.due
    ? `Local Review: a retro is due for ${name(c)}: ${cadenceSummary(c)} (${dueReasons(c).join('; ')}). ${how}`
    : `Local Review: no retro due yet for ${name(c)}: ${cadenceSummary(c)}. ${settings} ${how}`;
}

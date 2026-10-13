import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { purgeConfirmation, type HookInput } from '../src/hook';

const bash = (command: string): HookInput => ({
  session_id: 's1',
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command },
  cwd: '/work',
});

describe('deleting threads for good asks the user', () => {
  it('asks before slk review purge --yes, with the number announced', () => {
    expect(purgeConfirmation(bash('slk review purge --before 2026-09-15 --yes --count 3'))).toBe(
      'silykat: this deletes 3 comment threads for good (finished, with no activity since 2026-09-15): ' +
        'gone from the history and from retros. It runs only if the user allows it; if they refuse, nothing is deleted.',
    );
    expect(purgeConfirmation(bash('cd /work && /plugin/bin/slk review purge --yes --before 30d --count 1'))).toContain(
      'deletes 1 comment thread for good',
    );
    // A number of days is said as a date, with the number of days.
    const now = new Date(2026, 9, 3, 12).getTime();
    expect(purgeConfirmation(bash('slk review purge --before 60d --yes --count 2'), now)).toContain(
      'with no activity since 2026-08-04 (60 days)',
    );
    expect(purgeConfirmation(bash('slk review purge --yes'))).toBe(
      'silykat: this deletes old comment threads for good: gone from the history and from retros. ' +
        'It runs only if the user allows it; if they refuse, nothing is deleted.',
    );
  });

  it('asks before erasing the history kept', () => {
    expect(purgeConfirmation(bash('slk review purge --history --yes'))).toBe(
      'silykat: this erases for good the review history kept for retros: the deleted comment threads, ' +
        'and the threads saved from git worktrees. It runs only if the user allows it; if they refuse, nothing is deleted.',
    );
    expect(purgeConfirmation(bash('slk review purge --history'))).toBeNull();
  });

  it('lets everything else through', () => {
    for (const command of [
      'slk review purge --before 2026-09-15',
      'slk review archive --resolved-before 30d',
      'echo slk review purge',
      'ls',
    ])
      expect(purgeConfirmation(bash(command)), command).toBeNull();
    expect(purgeConfirmation({ ...bash('slk review purge --yes'), tool_name: 'Write' })).toBeNull();
    expect(purgeConfirmation({ session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Bash' })).toBeNull();
  });
});

describe('the plugin hook', () => {
  let home: string;
  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'slk-purge-hook-')));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('answers "ask" to Claude Code before slk review purge --yes', async () => {
    const hook = join(import.meta.dirname, '..', 'plugin', 'hooks', 'silykat-hook.js');
    const stdout = await new Promise<string>((done, fail) => {
      const child = execFile(process.execPath, [hook], { env: { ...process.env, SILYKAT_HOME: home } }, (err, out) =>
        err ? fail(err) : done(out),
      );
      child.stdin!.end(JSON.stringify({ ...bash('slk review purge --before 2026-09-15 --yes --count 2'), cwd: home }));
    });
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: expect.stringContaining('deletes 2 comment threads for good'),
      },
    });
  });
});

import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAnchorContext, readConfig, RetroBook, Store, type Anchor } from '@local-review/core';
import { runCli } from '../src/cli';

let base: string;
let work: string;
const env = () => ({ LOCAL_REVIEW_HOME: join(base, 'machine'), HOME: join(base, 'home') });

async function lr(args: string[]) {
  let out = '';
  let err = '';
  const code = await runCli(args, {
    cwd: work,
    env: env(),
    out: (t) => (out += t + '\n'),
    err: (t) => (err += t + '\n'),
    readStdin: async () => '',
    ancestors: async () => [],
  });
  return { code, out, err };
}

const anchor = (): Anchor => ({
  path: 'src/a.ts',
  source: 'worktree',
  ref: null,
  sha: null,
  ...buildAnchorContext('const a = 1;\n', { startLine: 1, endLine: 1 }),
});
const comment = async (body: string) =>
  (await new Store(join(work, 'api')).createThread(anchor(), { author: 'user', body, reviewId: null })).id;
const tick = () => new Promise((r) => setTimeout(r, 5));

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'lr-retro-loop-cli-')));
  work = join(base, 'work');
  await mkdir(work);
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const utc = (threads: string[], over: Record<string, unknown> = {}) => ({
  column: 'improve',
  subject: 'Dates are UTC',
  title: 'Say that dates are UTC',
  kind: 'rule',
  file: 'api/CLAUDE.md',
  change: '- Every date is UTC.',
  why: 'Threads ask for UTC',
  causes: ['UTC not written'],
  evidence: threads.map((thread) => ({ thread, excerpt: 'UTC' })),
  target: 'project-shared',
  targetEvidence: [threads[0]],
  confidence: 0.8,
  ...over,
});
const json = (x: unknown) => JSON.stringify(x);

async function startRetro(): Promise<string> {
  const started = await lr(['retro', 'start', '--format', 'json', '--all']);
  expect(started.code).toBe(0);
  return (JSON.parse(started.out) as { id: string }).id;
}

describe('the next retro checks the changes adopted at the last one', () => {
  it('shows with numbers whether the feedback went down, and what the user said about it', async () => {
    const before = [await comment('Dates are UTC'), await comment('UTC again'), await comment('Nice')];
    const first = await startRetro();
    expect((await lr(['retro', 'propose', first, '--body', json({ proposals: [utc(before.slice(0, 2))] })])).code).toBe(
      0,
    );
    await lr(['retro', 'decide', first, 'p1', 'accepted']);
    await lr(['retro', 'applied', first, 'p1', '--file', 'api/CLAUDE.md']);
    await lr(['retro', 'finish', first]);
    await tick();

    // Since then: the same feedback twice, out of three threads.
    const after = [await comment('Still local time'), await comment('UTC, again'), await comment('Typo')];
    expect((await lr(['retro', 'scope'])).out).toContain(
      'This retro will check whether the 1 change(s) adopted then reduced the feedback on their subject.',
    );
    const started = await lr(['retro', 'start', '--format', 'json']);
    const second = (JSON.parse(started.out) as { id: string }).id;
    await lr(['retro', 'feedback', second, '--body', 'Not really, it still uses local time']);
    const input = await lr(['retro', 'input', second, '--for', 'analysis']);
    expect(input.code).toBe(0);
    const ref = `${first}/p1`;

    const unchecked = await lr(['retro', 'check', second, '--body', json({ proposals: [] })]);
    expect(unchecked.out).toContain(`- REJECTED check of ${ref}: "verify" must check "Say that dates are UTC"`);
    const verify = [{ change: ref, threads: after.slice(0, 2), note: 'Two dates in local time again' }];
    const notRevised = await lr(['retro', 'check', second, '--body', json({ proposals: [], verify })]);
    expect(notRevised.code).toBe(1);
    expect(notRevised.out).toContain(
      'did not reduce the feedback on its subject (2 of 3 threads (67%) before, 2 of 3 threads (67%) since)',
    );
    expect(notRevised.out).toContain(
      `- ${ref} Say that dates are UTC: 2 of 3 threads (67%) before, 2 of 3 threads (67%) since → not decreased: to revise (${after[0]}, ${after[1]})`,
    );

    const revise = utc(after.slice(0, 2), {
      subject: 'UTC rule not followed',
      title: 'Check dates with a hook',
      kind: 'hook',
      causes: ['the rule is advisory'],
      revisits: ref,
    });
    const recorded = await lr(['retro', 'propose', second, '--body', json({ proposals: [revise], verify })]);
    expect(recorded.code).toBe(0);
    expect(recorded.out).toContain(`- p1 [improve] UTC rule not followed: 2 threads, revises ${ref}`);

    const shown = (await lr(['retro', 'show', second])).out;
    expect(shown).toContain("## The last retro's changes: did they help?");
    expect(shown).toContain('- **What you said about them**: Not really, it still uses local time');
    expect(shown).toContain(
      `- ${ref} Say that dates are UTC: 2 of 3 threads (67%) before, 2 of 3 threads (67%) since → not decreased: to revise`,
    );
    expect(shown).toContain('  Two dates in local time again');
    expect(shown).toContain(
      `- **Revises** ${ref}, adopted at the last retro: the feedback on its subject did not decrease`,
    );
    // A proposal that revises a change of the last retro is discussed first, and says so.
    const next = (await lr(['retro', 'show', second, '--next'])).out;
    expect(next).toContain('## Proposal 1/');
    expect(next).toContain(
      `**Revises** ${ref}, adopted at the last retro: the feedback on its subject did not decrease.`,
    );
    expect(JSON.parse((await lr(['retro', 'show', second, '--format', 'json'])).out).verifications).toMatchObject([
      { proposal: 'p1', verdict: 'not-decreased', files: [join(work, 'api', 'CLAUDE.md')] },
    ]);
    const kept = await lr([
      'retro',
      'check',
      second,
      '--body',
      json({ proposals: [], verify: [{ change: ref, threads: [] }] }),
    ]);
    expect(kept.out).toContain('0 of 3 threads (0%) since → stopped: kept');
  });
});

describe('the retro cadence', () => {
  it('tells whether a retro is due, and why', async () => {
    const empty = await lr(['retro', 'cadence']);
    expect(empty.out).toContain('No retro due yet: 0 B of review threads (0) and 0 agent sessions, no retro yet.');
    expect(empty.out).toContain(
      'Reminder settings (lr config): 7 days, or 1.0 MB of threads, and never more than 25 days.',
    );
    await comment('Use UTC. '.repeat(120));
    await lr(['config', 'set', 'retro-reminder-size', '1']);
    const due = await lr(['retro', 'cadence']);
    expect(due.out).toMatch(
      /^A retro is due: 0 days, .* of review threads \(1\) and 0 agent sessions since the first thread \(.*\), no retro yet\./,
    );
    expect(due.out).toContain('of threads to look back at (reminder at 1.0 KB)');
    expect(JSON.parse((await lr(['retro', 'cadence', '--format', 'json'])).out)).toMatchObject({
      due: true,
      reasons: ['size'],
      threads: 1,
      thresholds: { days: 7, bytes: 1000, maxDays: 25 },
    });
    expect((await lr(['retro', 'cadence', '--root', '/'])).err).toContain('not the root of the file system');
    // A finished retro starts the count again.
    const id = await startRetro();
    await new RetroBook(work).record(id, [{ type: 'retro.finished' }]);
    expect((await lr(['retro', 'cadence'])).out).toMatch(
      /^No retro due yet: 0 days, 0 B of review threads \(0\) and 0 agent sessions since the last retro/,
    );
  });

  it('takes its thresholds from the machine settings', async () => {
    expect((await lr(['config'])).out).toContain('retro-reminder-days: 7\n');
    expect((await lr(['config', 'set', 'retro-reminder-days', '5'])).out).toBe('retro-reminder-days is now 5.\n');
    await lr(['config', 'set', 'retro-reminder-max-days', '20']);
    await lr(['config', 'set', 'retro-reminder', 'off']);
    expect(await readConfig(env())).toMatchObject({
      retroReminderDays: 5,
      retroReminderMaxDays: 20,
      retroReminder: false,
    });
    expect((await lr(['config'])).out).toContain('retro-reminder: off\n');
    for (const bad of ['0', '2.5', 'soon'])
      expect((await lr(['config', 'set', 'retro-reminder-days', bad])).err).toContain(
        `retro-reminder-days takes a whole number, 1 or more, not "${bad}"`,
      );
    expect((await lr(['config', 'set', 'retro-reminder', '3'])).err).toContain('takes "on" or "off"');
  });
});

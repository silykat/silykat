import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAnchorContext, Store, type Anchor } from '@local-review/core';
import { EXIT, parseDateOption, runCli } from '../src/cli';

const CODE = ['export function find(id: string) {', '  const user = db.get(id);', '  if (!user) return null;', '}'];

let base: string;
const env = () => ({ LOCAL_REVIEW_HOME: join(base, 'machine') });

async function lr(args: string[], cwd = base) {
  let out = '';
  let err = '';
  const code = await runCli(args, {
    cwd,
    env: env(),
    out: (t) => (out += t + '\n'),
    err: (t) => (err += t + '\n'),
    readStdin: async () => '',
    ancestors: async () => [],
  });
  return { code, out, err };
}

const anchor = (line: number): Anchor => ({
  path: 'src/find.ts',
  source: 'worktree',
  ref: null,
  sha: null,
  ...buildAnchorContext(CODE.join('\n'), { startLine: line, endLine: line }),
});

/** Moves every date of a thread to a day of September 2026. */
async function backdate(store: Store, id: string, day: number): Promise<void> {
  const text = await readFile(store.threadFile(id), 'utf8');
  const at = `2026-09-${String(day).padStart(2, '0')}T10:00:00.000Z`;
  await writeFile(store.threadFile(id), text.replace(/"at":"[^"]+"/g, `"at":"${at}"`));
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'lr-archive-cli-')));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** A repository with an old resolved thread, a recent resolved one, an old open one and an old deleted one. */
async function project() {
  const store = new Store(join(base, 'api'));
  const create = (line: number, body: string) =>
    store.createThread(anchor(line), { author: 'user', body, reviewId: null });
  const oldResolved = await create(1, 'Throw here');
  await store.setStatus(oldResolved.id, 'resolved', 'user');
  await backdate(store, oldResolved.id, 2);
  const recent = await create(2, 'Name it user');
  await store.setStatus(recent.id, 'resolved', 'user');
  const oldOpen = await create(3, 'Still to do');
  await backdate(store, oldOpen.id, 2);
  const oldDeleted = await create(4, 'Never mind');
  await store.deleteThread(oldDeleted.id, 'user');
  await backdate(store, oldDeleted.id, 3);
  return { store, oldResolved, recent, oldOpen, oldDeleted };
}

describe('lr archive and lr unarchive', () => {
  it('archives the threads resolved before a date: gone from lr list, still in lr history', async () => {
    const { oldResolved, recent } = await project();
    const done = await lr(['archive', '--resolved-before', '2026-09-15', '--root', 'api']);
    expect(done).toMatchObject({ code: EXIT.OK, err: '' });
    expect(done.out).toContain('Archived 1 thread: it is no longer shown in the editor nor in lr list');

    const list = await lr(['list', '--all', '--format', 'json', '--root', 'api']);
    const listed = (JSON.parse(list.out) as { id: string }[]).map((t) => t.id);
    expect(listed).not.toContain(oldResolved.id);
    const shown = await lr(['show', oldResolved.id, '--root', 'api']);
    expect(shown.code).toBe(EXIT.NOT_FOUND);
    expect(shown.err).toContain('was archived by the user');

    const history = await lr(['history', '--root', 'api']);
    expect(history.out).toContain('— 1 archived');
    expect(history.out).toMatch(new RegExp(`${oldResolved.id}[^\\n]*\\n\\nStore: \\. · Archived \\d{4}-`));
    const json = JSON.parse((await lr(['history', '--root', 'api', '--format', 'json'])).out);
    expect(json.summary.archived).toBe(1);

    const archived = await lr(['archive', '--list', '--root', 'api']);
    expect(archived.out).toContain('1 archived thread in');
    expect(archived.out).toContain(`${oldResolved.id} · src/find.ts:1 · resolved · archived 20`);
    expect(archived.out).toContain('"Throw here"');
    const archivedJson = JSON.parse((await lr(['archive', '--list', '--format', 'json', '--root', 'api'])).out);
    expect(archivedJson).toMatchObject([{ id: oldResolved.id, state: 'resolved', firstComment: 'Throw here' }]);

    const back = await lr(['unarchive', oldResolved.id, '--root', 'api']);
    expect(back.out).toContain('Unarchived 1 thread: back in the editor and in lr list.');
    expect((await lr(['archive', '--list', '--root', 'api'])).out).toContain('No archived thread');
    expect(JSON.parse((await lr(['list', '--all', '--format', 'json', '--root', 'api'])).out)).toHaveLength(
      listed.length + 0,
    );
    // An explicit id, any state; the agent's view follows.
    const one = await lr(['archive', recent.id, '--format', 'json'], join(base, 'api'));
    expect(JSON.parse(one.out)).toEqual({ done: [recent.id], unchanged: [], failed: [] });
    // Nothing to do: said as such, not as done.
    const again = await lr(['archive', recent.id], join(base, 'api'));
    expect(again).toMatchObject({ code: EXIT.OK, out: '1 thread was already archived.\n' });
    const notArchived = await lr(['unarchive', oldResolved.id], join(base, 'api'));
    expect(notArchived.out).toBe('1 thread was not archived: nothing to do.\n');
  });

  it('says when nothing matches, and refuses unknown threads and mixed modes', async () => {
    await project();
    expect((await lr(['archive', '--resolved-before', '2026-09-01', '--root', 'api'])).out).toContain(
      'No resolved thread to archive',
    );
    const unknown = await lr(['archive', 't_01JAAAAAAAAAAAAAAAAAAAAAAA', '--root', 'api']);
    expect(unknown.code).toBe(EXIT.NOT_FOUND);
    expect(unknown.err).toContain('Thread not found: t_01JAAAAAAAAAAAAAAAAAAAAAAA');
    for (const args of [
      ['archive'],
      ['archive', 't_x', '--list'],
      ['unarchive'],
      ['archive', '--list', '--format', 'xml'],
    ]) {
      const r = await lr([...args, '--root', 'api']);
      expect(r.code, args.join(' ')).toBe(EXIT.ERROR);
    }
    expect((await lr(['archive', '--resolved-before', 'last week', '--root', 'api'])).err).toContain(
      '--resolved-before must be a date',
    );
  });

  it('reports a thread it could not archive', async () => {
    const { store, recent } = await project();
    await writeFile(store.threadFile(recent.id), '{"v":99,"type":"thread.archived","at":"x","by":"user"}\n', {
      flag: 'a',
    });
    const r = await lr(['archive', recent.id, '--root', 'api']);
    expect(r.code).toBe(EXIT.ERROR);
    expect(r.out).toContain(`Failed: ${recent.id}`);
    expect(r.out).toContain('newer version');
  });
});

describe('lr purge', () => {
  it('says how many and which, deletes nothing without --yes, then deletes exactly those', async () => {
    const { oldResolved, oldDeleted, oldOpen, recent } = await project();
    const preview = await lr(['purge', '--before', '2026-09-15', '--root', 'api']);
    expect(preview.code).toBe(EXIT.OK);
    expect(preview.out).toContain('2 threads would be deleted for good');
    expect(preview.out).toContain(oldResolved.id);
    expect(preview.out).toContain(oldDeleted.id);
    expect(preview.out).not.toContain(recent.id);
    expect(preview.out).toContain(
      '1 thread as old is still in progress (open, needs-info, addressed, or with a draft reply in your review): kept.',
    );
    expect(preview.out).toContain('lr purge --before 2026-09-15 --yes --count 2');
    expect((await lr(['history', '--root', 'api', '--format', 'json'])).out).toContain(oldResolved.id);

    const json = JSON.parse((await lr(['purge', '--before', '2026-09-15', '--root', 'api', '--format', 'json'])).out);
    expect(json.threads.map((t: { id: string }) => t.id).sort()).toEqual([oldResolved.id, oldDeleted.id].sort());
    expect(json.inProgress).toEqual([oldOpen.id]);

    const wrong = await lr(['purge', '--before', '2026-09-15', '--yes', '--count', '3', '--root', 'api']);
    expect(wrong.code).toBe(EXIT.ERROR);
    expect(wrong.err).toContain('2 threads now match, not 3');

    const done = await lr(['purge', '--before', '2026-09-15', '--yes', '--count', '2', '--root', 'api']);
    expect(done).toMatchObject({ code: EXIT.OK });
    expect(done.out).toContain('Deleted 2 threads for good');
    const left = JSON.parse((await lr(['history', '--root', 'api', '--format', 'json'])).out);
    expect(left.threads.map((t: { id: string }) => t.id).sort()).toEqual([recent.id, oldOpen.id].sort());

    const nothing = await lr(['purge', '--before', '2026-09-15', '--root', 'api']);
    expect(nothing.out).toContain('nothing to delete');
    expect((await lr(['purge', '--before', '2026-09-15', '--yes', '--root', 'api'])).out).toContain('nothing deleted');
  });

  it('needs a date', async () => {
    await project();
    expect((await lr(['purge', '--root', 'api'])).err).toContain('lr purge needs --before <date>');
    expect((await lr(['purge', 'x', '--before', '7d', '--root', 'api'])).code).toBe(EXIT.ERROR);
    expect((await lr(['purge', '--before', '7d', '--count', 'two', '--root', 'api'])).code).toBe(EXIT.ERROR);
  });
});

describe('lr history --out', () => {
  it('exports the history to a file', async () => {
    const { oldResolved } = await project();
    const r = await lr(['history', '--root', 'api', '--format', 'json', '--out', 'threads.json']);
    expect(r.out).toContain(`Wrote the history of 4 threads (json) to ${join(base, 'threads.json')}`);
    const exported = JSON.parse(await readFile(join(base, 'threads.json'), 'utf8'));
    expect(exported.threads.map((t: { id: string }) => t.id)).toContain(oldResolved.id);
    expect(exported.threads[0]).toHaveProperty('archivedAt');
  });
});

describe('parseDateOption', () => {
  it('names the option in its error', () => {
    expect(parseDateOption('2026-10-01', '--before').getTime()).toBe(new Date(2026, 9, 1).getTime());
    expect(() => parseDateOption('soon', '--before')).toThrow('--before must be a date');
  });
});

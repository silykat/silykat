import { resolve } from 'node:path';
import {
  archivedThreads,
  archiveThreads,
  dateArgLabel,
  eraseHistory,
  formatBytes,
  historyPlan,
  historySummary,
  projectThreads,
  purgePlan,
  purgeThreads,
  resolvedBefore,
  retroReading,
  storeLabel,
  unarchiveThreads,
  type BatchResult,
  type ProjectThread,
  type PurgePlan,
} from '@local-review/core';
import { parse, str, UsageError } from './args';
import type { Io } from './cli';

/** Exit codes shared with the other commands. */
const OK = 0;
const ERROR = 1;

export const ARCHIVE_USAGE = `Archive and clean up (on the project, as lr history: the folder, its subfolders, its worktrees).
Archived threads leave the editor and lr list, and stay in lr history and in retros. Only do this
when the user asks:
  lr archive <thread-id>…                 Archive these threads
  lr archive --resolved-before <date>     Archive every thread resolved before a date (2026-10-01,
                                          or 30d for 30 days ago)
  lr archive --list [--format md|json]    The archived threads
  lr unarchive <thread-id>…               Bring archived threads back to the editor
  lr purge --before <date> [--yes [--count <n>]] [--format md|json]
                                          Delete for good the finished threads (resolved, archived
                                          or deleted) with nothing published since a date. Without
                                          --yes, only says how many and which: show the user, and
                                          run it again with --yes once they confirm (--count: the
                                          number announced; refused if it changed). Threads still
                                          in progress are kept, and so are those a retro has not
                                          read yet. Keep a copy first: lr history --format json
                                          --out <file>
  lr purge --history [--yes] [--format md|json]
                                          Erase the history kept for retros: the deleted threads,
                                          and the threads saved from worktrees (when the user no
                                          longer keeps it: lr config set keep-history off)`;

type DateOption = (value: string, flag: string) => Date;

/** `lr archive`: by id, every thread resolved before a date, or the list of archived threads. */
export async function archive(rest: string[], io: Io, dateOption: DateOption): Promise<number> {
  const { values, positionals } = parse(rest, {
    'resolved-before': { type: 'string' },
    list: { type: 'boolean' },
    format: { type: 'string' },
  });
  const format = formatOf(str(values.format));
  const root = resolve(io.cwd, str(values.root) ?? '.');
  const resolvedOption = str(values['resolved-before']);
  const modes = [positionals.length > 0, resolvedOption !== undefined, values.list === true].filter(Boolean).length;
  if (modes !== 1)
    throw new UsageError('lr archive takes thread ids, or --resolved-before <date>, or --list (one of them)');
  const threads = await projectThreads([root], io.env);

  if (values.list === true) {
    const archived = archivedThreads(threads);
    if (format === 'json')
      io.out(
        JSON.stringify(
          archived.map((t) => threadJson(t)),
          null,
          2,
        ),
      );
    else
      io.out(
        archived.length === 0
          ? `No archived thread in ${root}.`
          : [
              `${plural(archived.length, 'archived thread')} in ${root} (lr unarchive <id> brings one back):`,
              ...archived.map((t) => `  ${threadLine(t, root)}`),
            ].join('\n'),
      );
    return OK;
  }

  const date = resolvedOption === undefined ? null : dateOption(resolvedOption, '--resolved-before');
  const selected = date ? resolvedBefore(threads, date) : byIds(threads, positionals, root);
  const result = await archiveThreads(selected);
  return report(io, format, result, selected, root, {
    none: date
      ? `No resolved thread to archive: none was resolved before ${dateArgLabel(resolvedOption!, date)} in ${root}.`
      : 'Nothing to archive.',
    done: (n) =>
      `Archived ${plural(n, 'thread')}: ${n === 1 ? 'it is' : 'they are'} no longer shown in the editor nor in lr list, ` +
      `and ${n === 1 ? 'stays' : 'stay'} in lr history and in retros (lr unarchive <id> brings one back).`,
    unchanged: (n) => `${plural(n, 'thread')} ${n === 1 ? 'was' : 'were'} already archived.`,
  });
}

/** `lr unarchive <id>…`: archived threads come back to the editor. */
export async function unarchive(rest: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(rest, { format: { type: 'string' } });
  const format = formatOf(str(values.format));
  if (positionals.length === 0) throw new UsageError('missing <thread-id>');
  const root = resolve(io.cwd, str(values.root) ?? '.');
  const selected = byIds(await projectThreads([root], io.env), positionals, root);
  const result = await unarchiveThreads(selected);
  return report(io, format, result, selected, root, {
    none: 'Nothing to unarchive.',
    done: (n) => `Unarchived ${plural(n, 'thread')}: back in the editor and in lr list.`,
    unchanged: (n) => `${plural(n, 'thread')} ${n === 1 ? 'was' : 'were'} not archived: nothing to do.`,
  });
}

/** `lr purge --before <date>`: says what would go; deletes for good with `--yes`. */
export async function purge(rest: string[], io: Io, dateOption: DateOption): Promise<number> {
  const { values, positionals } = parse(rest, {
    before: { type: 'string' },
    history: { type: 'boolean' },
    yes: { type: 'boolean' },
    count: { type: 'string' },
    format: { type: 'string' },
  });
  if (positionals.length > 0) throw new UsageError(`lr purge takes no argument: "${positionals[0]}"`);
  const format = formatOf(str(values.format));
  const root = resolve(io.cwd, str(values.root) ?? '.');
  const beforeOption = str(values.before);
  if (values.history === true) {
    if (beforeOption !== undefined || values.count !== undefined)
      throw new UsageError('lr purge --history takes neither --before nor --count');
    return purgeHistory(root, values.yes === true, format, io);
  }
  if (beforeOption === undefined) throw new UsageError('lr purge needs --before <date> (or --history)');
  const date = dateOption(beforeOption, '--before');
  const since = dateArgLabel(beforeOption, date);
  const count = str(values.count);
  if (count !== undefined && !/^\d+$/.test(count)) throw new UsageError(`--count must be a number, not "${count}"`);
  const plan = purgePlan(await projectThreads([root], io.env), date, await retroReading([root]));
  const n = plan.threads.length;

  if (values.yes !== true) {
    if (format === 'json') {
      io.out(
        JSON.stringify(
          {
            before: date.toISOString(),
            threads: plan.threads.map((t) => threadJson(t)),
            bytes: plan.bytes,
            inProgress: plan.inProgress.map((t) => t.thread.id),
            unreadByRetro: plan.unread.map((t) => t.thread.id),
            retro: plan.retro,
          },
          null,
          2,
        ),
      );
      return OK;
    }
    const kept =
      (plan.inProgress.length > 0
        ? `\n${plural(plan.inProgress.length, 'thread')} as old ${plan.inProgress.length === 1 ? 'is' : 'are'} still in progress (open, needs-info, addressed, or with a draft reply in your review): kept.`
        : '') + retroNote(plan);
    io.out(
      n === 0
        ? `No finished thread without activity since ${since} in ${root}: nothing to delete.${kept}`
        : [
            `${plural(n, 'thread')} would be deleted for good (finished, nothing published since ${since}; ${formatBytes(plan.bytes)}):`,
            ...plan.threads.map((t) => `  ${threadLine(t, root)}`),
          ].join('\n') +
            kept +
            `\nNothing is deleted yet: they stay in lr history and in retros until then. Keep a copy first with ` +
            `lr history --format json --out <file>. To delete ${n === 1 ? 'it' : 'these ' + n} for good: ` +
            `lr purge --before ${beforeOption} --yes --count ${n}`,
    );
    return OK;
  }

  if (count !== undefined && Number(count) !== n) {
    io.err(
      `lr: ${plural(n, 'thread')} now match${n === 1 ? 'es' : ''}, not ${count}: the threads changed since. ` +
        `Nothing was deleted: run lr purge --before ${beforeOption} again to see them.`,
    );
    return ERROR;
  }
  const result = await purgeThreads(plan.threads);
  return report(io, format, result, plan.threads, root, {
    none: `No finished thread without activity since ${since}: nothing deleted.`,
    done: (k) => `Deleted ${plural(k, 'thread')} for good (${formatBytes(plan.bytes)}).`,
  });
}

/** What the preview says about retros: the threads kept for them, or that there is no retro to wait for. */
function retroNote(plan: PurgePlan): string {
  if (!plan.retro) return '\nNo retro in this project yet: no thread is kept for one.';
  const k = plan.unread.length;
  return k === 0
    ? ''
    : `\n${plural(k, 'finished thread')} as old ${k === 1 ? 'is' : 'are'} not read by a retro yet: kept for the next one.`;
}

/** `lr purge --history`: says what history is kept; erases it with `--yes`. */
async function purgeHistory(root: string, yes: boolean, format: 'md' | 'json', io: Io): Promise<number> {
  const plan = await historyPlan([root], io.env);
  const summary = historySummary(plan.deleted.length, plan.saved.length);
  if (!yes) {
    if (format === 'json')
      io.out(
        JSON.stringify(
          { deleted: plan.deleted.map((t) => threadJson(t)), saved: plan.saved.map((s) => s.saved!.dir) },
          null,
          2,
        ),
      );
    else
      io.out(
        summary === null
          ? `No history kept in ${root}: nothing to erase.`
          : `History kept in ${root}: ${summary}. Nothing is erased yet. To erase it for good (gone from lr history ` +
              `and from retros): lr purge --history --yes`,
      );
    return OK;
  }
  const erased = await eraseHistory(plan);
  if (format === 'json') io.out(JSON.stringify(erased, null, 2));
  else
    io.out(
      erased.threads + erased.saved === 0
        ? 'No history kept: nothing erased.'
        : `Erased for good: ${historySummary(erased.threads, erased.saved)}.`,
    );
  return OK;
}

function byIds(threads: ProjectThread[], ids: string[], root: string): ProjectThread[] {
  return ids.map((id) => {
    const found = threads.find((t) => t.thread.id === id);
    if (!found) throw new Error(`Thread not found: ${id} (in ${root}, its subfolders and its worktrees)`);
    return found;
  });
}

function report(
  io: Io,
  format: 'md' | 'json',
  result: BatchResult,
  selected: ProjectThread[],
  root: string,
  text: { none: string; done: (n: number) => string; unchanged?: (n: number) => string },
): number {
  if (format === 'json') io.out(JSON.stringify(result, null, 2));
  else {
    const lines = [
      selected.length === 0 ? text.none : result.done.length > 0 ? text.done(result.done.length) : '',
      text.unchanged && result.unchanged.length > 0 ? text.unchanged(result.unchanged.length) : '',
    ];
    for (const f of result.failed) {
      const t = selected.find((x) => x.thread.id === f.id);
      lines.push(`Failed: ${t ? threadLine(t, root) : f.id}: ${f.error}`);
    }
    io.out(lines.filter((l) => l !== '').join('\n'));
  }
  return result.failed.length > 0 ? ERROR : OK;
}

function formatOf(format: string | undefined): 'md' | 'json' {
  const f = format ?? 'md';
  if (f !== 'md' && f !== 'json') throw new UsageError(`--format must be "md" or "json", not "${f}"`);
  return f;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What a thread is about, on one line: id, place, state, dates, and the start of its first comment. */
export function threadLine({ thread: t, store }: ProjectThread, root: string): string {
  const a = t.anchor;
  const place = a.range ? `${a.path}:${a.range.startLine}` : `${a.path} (whole file)`;
  const first = t.conversation.find((e) => e.kind === 'comment');
  const excerpt = first?.kind === 'comment' ? first.body.split('\n')[0]!.trim() : '';
  const facts = [
    t.id,
    storeLabel(store, root) === '.' ? place : `${storeLabel(store, root)}: ${place}`,
    t.state,
    ...(t.archivedAt ? [`archived ${t.archivedAt.slice(0, 10)}`] : []),
    `last activity ${t.lastActivityAt.slice(0, 10)}`,
  ];
  return `${facts.join(' · ')} — "${excerpt.length > 60 ? `${excerpt.slice(0, 59)}…` : excerpt}"`;
}

function threadJson({ thread: t, store }: ProjectThread) {
  const first = t.conversation.find((e) => e.kind === 'comment');
  return {
    id: t.id,
    store: store.root,
    path: t.anchor.path,
    range: t.anchor.range,
    state: t.state,
    archivedAt: t.archivedAt,
    resolvedAt: t.resolvedAt,
    lastActivityAt: t.lastActivityAt,
    firstComment: first?.kind === 'comment' ? first.body : null,
    bytes: t.bytes,
  };
}

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  agentView,
  findStoreRoot,
  findStoresBelow,
  localReviewHome,
  processAncestors,
  SessionRegistry,
  sessionOfProcess,
  topicLabel,
  topicOf,
  Store,
  type AgentThreadView,
  type ThreadStatus,
} from '@local-review/core';
import { locate, renderReviews, renderThread, type Located } from './digest';

export interface Io {
  cwd: string;
  env: Record<string, string | undefined>;
  out(text: string): void;
  err(text: string): void;
  readStdin(): Promise<string>;
  /** Parent processes of this command, closest first: to find the agent session it runs in. */
  ancestors?(): Promise<number[]>;
}

/** Exit codes. `NOT_FOUND` lets an agent tell "this thread is gone" from other errors. */
export const EXIT = { OK: 0, ERROR: 1, NOT_FOUND: 2 } as const;

class UsageError extends Error {}

const USAGE = `lr — Local Review, for agents

Usage:
  lr status                               How many threads wait for you
  lr list [--all] [--thread <id>]… [--format md|json]
                                          Threads waiting for you (--all: every unresolved thread;
                                          --thread: only those threads)
  lr show <thread-id> [--format md|json]  One thread, in full
  lr reply <thread-id> --agent <name> (--body <markdown> | --body-file <path> | --body -)
           [--status addressed|needs-info]
  lr set-status <thread-id> addressed|needs-info --agent <name>

Subscriptions (comments are published to the sessions subscribed to their branch or path):
  lr subscribe [<dir-or-file>] [--path]   Subscribe this session to the branch of that folder
                                          (default: the current one), or to the path itself
                                          (--path, and always outside git)
  lr unsubscribe [<dir-or-file>] [--path] [--all]
  lr subscriptions [--format md|json]     What this session is subscribed to
  (the session is found from the processes running lr; --session <id> or $LR_SESSION to name it)

Sessions (used by agent integrations to register themselves):
  lr sessions [--format md|json]          Running agent sessions on this machine
  lr session register --id <id> --agent <name> --cwd <dir> [--branch <b>] [--pid <n>]
                     [--push yes|no] [--push-command <command>]
  lr session unregister --id <id>

Options:
  --root <dir>    Folder holding .local-review/ (default: found from the current directory)
  --agent <name>  Your display name in the threads (default: $LR_AGENT)

Statuses: "addressed" = done, the user will verify; "needs-info" = you asked the user a question.
Only the user resolves threads.`;

export async function runCli(args: string[], io: Io): Promise<number> {
  const [command, ...rest] = args;
  try {
    switch (command) {
      case 'status':
        return await status(rest, io);
      case 'list':
        return await list(rest, io);
      case 'show':
        return await show(rest, io);
      case 'reply':
        return await reply(rest, io);
      case 'set-status':
        return await setStatus(rest, io);
      case 'sessions':
        return await sessions(rest, io);
      case 'session':
        return await session(rest, io);
      case 'subscribe':
        return await subscribe(rest, io);
      case 'unsubscribe':
        return await unsubscribe(rest, io);
      case 'subscriptions':
        return await subscriptions(rest, io);
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        io.out(USAGE);
        return command === undefined ? EXIT.ERROR : EXIT.OK;
      default:
        throw new UsageError(`Unknown command: ${command}`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`lr: ${err.message}\n\n${USAGE}`);
      return EXIT.ERROR;
    }
    const message = err instanceof Error ? err.message : String(err);
    io.err(`lr: ${message}`);
    return /not found/i.test(message) ? EXIT.NOT_FOUND : EXIT.ERROR;
  }
}

type Values = Record<string, string | boolean | string[] | undefined>;

function parse(
  rest: string[],
  options: Record<string, { type: 'string' | 'boolean'; multiple?: boolean }>,
): { values: Values; positionals: string[] } {
  try {
    const parsed = parseArgs({ args: rest, options: { root: { type: 'string' }, ...options }, allowPositionals: true });
    return { values: parsed.values as Values, positionals: parsed.positionals };
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

const str = (v: Values[string]): string | undefined => (typeof v === 'string' ? v : undefined);

function openStore(root: string | undefined, io: Io): Store {
  const dir = root ? resolve(io.cwd, root) : findStoreRoot(io.cwd, io.env);
  if (dir) return new Store(dir);
  const below = findStoresBelow(io.cwd, 3, io.env);
  const hint =
    below.length > 0
      ? `Stores below this folder:\n${below.map((b) => `  ${b}`).join('\n')}\nRun the command in one of them, or pass --root <dir>.`
      : 'Nothing has been commented in this folder or above yet.';
  throw new Error(`no Local Review store in ${io.cwd} or above. ${hint}`);
}

/** Every thread an agent can see, located in the current files. */
async function visibleThreads(store: Store): Promise<{ located: Located[]; store: Store }> {
  const { threads } = await store.loadAll();
  const views = threads.map(agentView).filter((v): v is AgentThreadView => v !== null);
  const located = await Promise.all(views.map(async (v) => locate(v, await readWorkingFile(store, v))));
  located.sort((a, b) => a.view.thread.anchor.path.localeCompare(b.view.thread.anchor.path) || lineOf(a) - lineOf(b));
  return { located, store };
}

async function readWorkingFile(store: Store, view: AgentThreadView): Promise<string | null> {
  if (view.thread.anchor.source !== 'worktree') return null;
  try {
    return await readFile(join(store.root, ...view.thread.anchor.path.split('/')), 'utf8');
  } catch {
    return null;
  }
}

const lineOf = (l: Located) => l.range?.startLine ?? 0;

async function status(rest: string[], io: Io): Promise<number> {
  const { values } = parse(rest, {});
  const { located } = await visibleThreads(openStore(str(values.root), io));
  const forAgent = located.filter((l) => l.view.needsAgent).length;
  const forUser = located.filter((l) => l.view.waitsForUser).length;
  io.out(`${forAgent} thread${forAgent === 1 ? '' : 's'} waiting for you · ${forUser} waiting for the user`);
  return EXIT.OK;
}

async function list(rest: string[], io: Io): Promise<number> {
  const { values } = parse(rest, {
    all: { type: 'boolean' },
    thread: { type: 'string', multiple: true },
    format: { type: 'string' },
  });
  const only = Array.isArray(values.thread) ? new Set(values.thread) : undefined;
  const { located } = await visibleThreads(openStore(str(values.root), io));
  const selected = located.filter(
    (l) =>
      (only === undefined || only.has(l.view.thread.id)) &&
      (values.all === true ? l.view.thread.status !== 'resolved' : l.view.needsAgent),
  );
  if (str(values.format) === 'json') {
    io.out(JSON.stringify(selected.map(toJson), null, 2));
    return EXIT.OK;
  }
  if (selected.length === 0) {
    io.out(
      values.all === true ? 'No unresolved thread.' : 'Nothing waits for you: no thread where the user spoke last.',
    );
    return EXIT.OK;
  }
  const store = openStore(str(values.root), io);
  const { reviews } = await store.loadAll();
  const n = selected.length;
  const parts = [
    `# Local Review — ${n} thread${n === 1 ? '' : 's'} ${values.all === true ? 'unresolved' : 'waiting for you'}`,
  ];
  const summaries = renderReviews(selected, reviews);
  if (summaries) parts.push(summaries);
  parts.push(...selected.map(renderThread));
  io.out(parts.join('\n\n'));
  return EXIT.OK;
}

async function show(rest: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(rest, { format: { type: 'string' } });
  const id = requireThreadId(positionals);
  const { located } = await visibleThreads(openStore(str(values.root), io));
  const found = located.find((l) => l.view.thread.id === id);
  if (!found) throw new Error(`Thread not found: ${id}`);
  io.out(str(values.format) === 'json' ? JSON.stringify(toJson(found), null, 2) : renderThread(found));
  return EXIT.OK;
}

async function reply(rest: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(rest, {
    agent: { type: 'string' },
    body: { type: 'string' },
    'body-file': { type: 'string' },
    status: { type: 'string' },
  });
  const id = requireThreadId(positionals);
  const agent = requireAgent(str(values.agent), io);
  const status = str(values.status) === undefined ? undefined : agentStatus(str(values.status));
  let body = str(values.body);
  if (body === '-') body = await io.readStdin();
  const bodyFile = str(values['body-file']);
  if (bodyFile) body = await readFile(resolve(io.cwd, bodyFile), 'utf8');
  if (body === undefined || body.trim() === '') throw new UsageError('reply needs --body, --body-file or --body -');

  const state = await openStore(str(values.root), io).addComment(
    id,
    { author: 'agent', agent, body, reviewId: null },
    status ? { status } : {},
  );
  io.out(`Replied on ${state.id} (status: ${state.status}).`);
  return EXIT.OK;
}

async function setStatus(rest: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(rest, { agent: { type: 'string' } });
  const id = requireThreadId(positionals);
  const status = agentStatus(positionals[1]);
  const state = await openStore(str(values.root), io).setStatus(
    id,
    status,
    'agent',
    requireAgent(str(values.agent), io),
  );
  io.out(`${state.id} is now ${state.status}.`);
  return EXIT.OK;
}

const registryFor = (io: Io) => new SessionRegistry(localReviewHome(io.env));

async function sessions(rest: string[], io: Io): Promise<number> {
  const { values } = parse(rest, { format: { type: 'string' } });
  const list = await registryFor(io).list();
  if (str(values.format) === 'json') {
    io.out(JSON.stringify(list, null, 2));
    return EXIT.OK;
  }
  if (list.length === 0) {
    io.out('No agent session is running.');
    return EXIT.OK;
  }
  io.out(
    list
      .map(
        (x) =>
          `${x.agent} ${x.id.slice(0, 8)} · ${x.branch ?? 'no branch'} · ${x.cwd}${x.push === false ? ' · no push' : ''}` +
          x.subscriptions.map((sub) => `\n  subscribed to ${topicLabel(sub.topic)} (${sub.reason})`).join(''),
      )
      .join('\n'),
  );
  return EXIT.OK;
}

async function session(rest: string[], io: Io): Promise<number> {
  const [action, ...args] = rest;
  const { values, positionals } = parse(args, {
    id: { type: 'string' },
    agent: { type: 'string' },
    cwd: { type: 'string' },
    branch: { type: 'string' },
    pid: { type: 'string' },
    push: { type: 'string' },
    'push-command': { type: 'string' },
  });
  const id = str(values.id);
  if (!id) throw new UsageError('missing --id <session id>');
  const registry = registryFor(io);
  switch (action) {
    case 'register': {
      const pid = str(values.pid) === undefined ? null : Number(str(values.pid));
      if (pid !== null && !Number.isInteger(pid)) throw new UsageError('--pid must be a process id');
      const push = str(values.push);
      if (push !== undefined && push !== 'yes' && push !== 'no') throw new UsageError('--push must be "yes" or "no"');
      await registry.register({
        id,
        agent: requireAgent(str(values.agent), io),
        cwd: resolve(io.cwd, str(values.cwd) ?? '.'),
        branch: str(values.branch) ?? null,
        pid,
        startedAt: new Date().toISOString(),
        push: push === undefined ? null : push === 'yes',
        pushCommand: str(values['push-command']) ?? null,
      });
      io.out(`Session ${id} registered.`);
      return EXIT.OK;
    }
    case 'unregister':
      await registry.unregister(id);
      io.out(`Session ${id} unregistered.`);
      return EXIT.OK;
    default:
      throw new UsageError(`unknown session action: ${action ?? '(none)'}`);
  }
}

const subscriptionOptions = {
  session: { type: 'string' as const },
  path: { type: 'boolean' as const },
  all: { type: 'boolean' as const },
  format: { type: 'string' as const },
};

/** The agent session this command runs in. */
async function currentSession(values: Values, io: Io): Promise<{ registry: SessionRegistry; id: string }> {
  const registry = registryFor(io);
  const named = str(values.session) ?? io.env.LR_SESSION?.trim();
  if (named) return { registry, id: named };
  const found = sessionOfProcess(await registry.list(), (await io.ancestors?.()) ?? (await processAncestors()));
  if (!found)
    throw new Error(
      'this command does not run in a registered agent session. Pass --session <id> (see lr sessions), or set LR_SESSION.',
    );
  return { registry, id: found.id };
}

async function subscribe(rest: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(rest, subscriptionOptions);
  const { registry, id } = await currentSession(values, io);
  const topic = await topicOf(resolve(io.cwd, positionals[0] ?? '.'), { asPath: values.path === true });
  const added = await registry.subscribe(id, topic, 'user');
  io.out(`${added ? 'Subscribed to' : 'Already subscribed to'} ${topicLabel(topic)}.`);
  return EXIT.OK;
}

async function unsubscribe(rest: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(rest, subscriptionOptions);
  const { registry, id } = await currentSession(values, io);
  const gone = await registry.unsubscribe(
    id,
    values.all === true
      ? 'all'
      : await topicOf(resolve(io.cwd, positionals[0] ?? '.'), { asPath: values.path === true }),
  );
  io.out(
    gone.length === 0
      ? 'Not subscribed to that.'
      : `Unsubscribed from ${gone.map((g) => topicLabel(g.topic)).join(', ')}.`,
  );
  return EXIT.OK;
}

async function subscriptions(rest: string[], io: Io): Promise<number> {
  const { values } = parse(rest, subscriptionOptions);
  const { registry, id } = await currentSession(values, io);
  const subs = await registry.subscriptions(id);
  if (str(values.format) === 'json') io.out(JSON.stringify(subs, null, 2));
  else
    io.out(
      subs.length === 0
        ? 'This session is subscribed to nothing: comments reach it only when the user asks.'
        : subs.map((sub) => `${topicLabel(sub.topic)} (${sub.reason})`).join('\n'),
    );
  return EXIT.OK;
}

function requireThreadId(positionals: string[]): string {
  const id = positionals[0];
  if (!id) throw new UsageError('missing <thread-id>');
  return id;
}

function requireAgent(flag: string | undefined, io: Io): string {
  const agent = (flag ?? io.env.LR_AGENT)?.trim();
  if (!agent) throw new UsageError('say who you are with --agent <name> (or set LR_AGENT)');
  return agent;
}

/** Agents may only mark a thread done or ask a question: resolving is the user's call. */
function agentStatus(value: string | undefined): ThreadStatus {
  if (value === 'addressed' || value === 'needs-info') return value;
  throw new UsageError(`status must be "addressed" or "needs-info"${value ? `, not "${value}"` : ''}`);
}

function toJson(l: Located) {
  const { thread, comments, needsAgent, waitsForUser } = l.view;
  return {
    id: thread.id,
    path: thread.anchor.path,
    source: thread.anchor.source,
    ref: thread.anchor.ref,
    sha: thread.anchor.sha,
    range: l.range,
    outdated: l.outdated,
    code: l.code,
    status: thread.status,
    needsAgent,
    waitsForUser,
    comments: comments.map((c) => ({
      author: c.author === 'user' ? 'user' : (c.agentName ?? 'agent'),
      body: c.body,
      createdAt: c.createdAt,
      edited: c.editedAt !== undefined,
    })),
  };
}

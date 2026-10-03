import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ThreadHistory } from '@local-review/core';

// Claude Code's conversations (transcripts) are an internal format of Claude Code, not a contract:
// they are only read here, in the adapter, and only to show a retro what the agent did for a thread.
// Each line is an entry: a user prompt or tool result, an assistant text or tool call (one content
// block per line), or bookkeeping (attachments, snapshots…) that is skipped.

/** One line of a transcript, the parts we read. */
export interface TranscriptEntry {
  type?: string;
  timestamp?: string;
  isMeta?: boolean;
  attributionSkill?: string;
  message?: {
    id?: string;
    role?: string;
    content?: string | ContentBlock[];
    usage?: Usage;
  };
}

interface ContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** An agent reply of a thread that recorded its conversation. */
export interface LinkedReply {
  session: string;
  message?: string;
  at: string;
}

/** The agent replies of a thread linked to a conversation, oldest first. */
export function linkedReplies(t: ThreadHistory): LinkedReply[] {
  return t.conversation.flatMap((e) =>
    e.kind === 'comment' && e.author === 'agent' && e.session
      ? [{ session: e.session.id, ...(e.session.message ? { message: e.session.message } : {}), at: e.at }]
      : [],
  );
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The transcript files of a Claude Code session: `<claude dir>/projects/<folder>/<session>.jsonl`,
 * then those of its sub-agents (`<session>/subagents/*.jsonl`). Empty once Claude Code deleted them.
 */
export async function transcriptsOf(claudeDir: string, session: string): Promise<string[]> {
  if (!SAFE_ID.test(session)) return [];
  const projects = join(claudeDir, 'projects');
  let folders: string[];
  try {
    folders = await readdir(projects);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const folder of folders.sort()) {
    const main = join(projects, folder, `${session}.jsonl`);
    if (await readable(main)) found.push(main);
    try {
      const sub = join(projects, folder, session, 'subagents');
      for (const f of (await readdir(sub)).sort()) if (f.endsWith('.jsonl')) found.push(join(sub, f));
    } catch {
      // no sub-agent
    }
  }
  return found;
}

const readable = (file: string): Promise<boolean> =>
  stat(file).then(
    (s) => s.isFile(),
    () => false,
  );

export function parseTranscript(text: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const raw = JSON.parse(line) as unknown;
      if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) entries.push(raw as TranscriptEntry);
    } catch {
      // a line being written, or corrupt: skip it
    }
  }
  return entries;
}

const blocks = (e: TranscriptEntry): ContentBlock[] =>
  Array.isArray(e.message?.content) ? e.message.content.filter((b) => typeof b === 'object' && b !== null) : [];

const toolUses = (e: TranscriptEntry) => (e.type === 'assistant' ? blocks(e).filter((b) => b.type === 'tool_use') : []);

/** A prompt: what starts a turn (the user's message, a channel message…), not a tool result. */
function isPrompt(e: TranscriptEntry): boolean {
  if (e.type !== 'user' || e.isMeta) return false;
  const c = e.message?.content;
  if (typeof c === 'string') return true;
  const bs = blocks(e);
  return bs.some((b) => b.type === 'text') && !bs.some((b) => b.type === 'tool_result');
}

/** Slack after the reply's time: the tool call starts a moment before `lr reply` writes. */
const LATE_MS = 60_000;

/**
 * Where a reply is in a transcript: the tool call recorded with it, else the latest `lr reply`
 * naming the thread made before it was written. `-1` when it is not in this transcript.
 */
export function findReply(entries: readonly TranscriptEntry[], reply: LinkedReply, threadId: string): number {
  if (reply.message) {
    const i = entries.findIndex((e) => toolUses(e).some((b) => b.id === reply.message));
    if (i >= 0) return i;
  }
  const until = Date.parse(reply.at) + LATE_MS;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (Date.parse(e.timestamp ?? '') > until) continue;
    const named = toolUses(e).some((b) => {
      const command = b.input?.command;
      return typeof command === 'string' && /\blr\b/.test(command) && command.includes(threadId);
    });
    if (named) return i;
  }
  return -1;
}

const clip = (text: string, max: number): string => {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max)}… (${t.length - max} more characters)`;
};

const oneLine = (text: string, max: number) => clip(text.replace(/\s+/g, ' '), max);

function promptText(e: TranscriptEntry): string {
  const c = e.message?.content;
  if (typeof c === 'string') return c;
  return blocks(e)
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n');
}

function resultText(b: ContentBlock): string {
  if (typeof b.content === 'string') return b.content;
  if (Array.isArray(b.content))
    return (b.content as ContentBlock[])
      .filter((x) => x?.type === 'text')
      .map((x) => x.text ?? '')
      .join('\n');
  return '';
}

/** What a tool call did, in one line. */
function toolLine(b: ContentBlock): string {
  const input = b.input ?? {};
  const pick = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined);
  const what =
    pick('command') ??
    pick('file_path') ??
    pick('notebook_path') ??
    (pick('pattern') ? `${pick('pattern')}${pick('path') ? ` in ${pick('path')}` : ''}` : undefined) ??
    pick('description') ??
    pick('url') ??
    JSON.stringify(input);
  return `${b.name ?? 'tool'}: ${oneLine(what, 400)}`;
}

/** The lines of one entry, `[]` for what a retro does not need (thinking, bookkeeping). */
function renderEntry(e: TranscriptEntry, mark: string | null): string[] {
  const at = e.timestamp ? e.timestamp.slice(11, 19) : '';
  if (isPrompt(e)) return [`- **Prompt** (${at}): ${clip(promptText(e), 2000)}`];
  if (e.type === 'assistant') {
    return blocks(e).flatMap((b) => {
      if (b.type === 'text' && b.text?.trim()) return [`- **Claude** (${at}): ${clip(b.text, 1500)}`];
      if (b.type === 'tool_use')
        return [`- ${mark && b.id === mark ? '**This call wrote the reply** → ' : '→ '}${toolLine(b)}`];
      return [];
    });
  }
  if (e.type === 'user')
    return blocks(e)
      .filter((b) => b.type === 'tool_result')
      .map((b) => `  - ${b.is_error ? 'error' : 'result'}: ${oneLine(resultText(b), 300) || '(empty)'}`);
  return [];
}

/** Tokens of the model calls of a turn (each call is split in several entries: counted once). */
function turnUsage(entries: readonly TranscriptEntry[]): string | null {
  const calls = new Map<string, Usage>();
  for (const e of entries)
    if (e.type === 'assistant' && e.message?.usage) calls.set(e.message.id ?? String(calls.size), e.message.usage);
  if (calls.size === 0) return null;
  let input = 0;
  let cached = 0;
  let output = 0;
  for (const u of calls.values()) {
    input += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    cached += u.cache_read_input_tokens ?? 0;
    output += u.output_tokens ?? 0;
  }
  return `${calls.size} model call(s), ${input} tokens in (${cached} read from the cache), ${output} out`;
}

/** Characters of one conversation's excerpt: the steps closest to the reply are kept. */
export const EXCERPT_BUDGET = 12_000;

/**
 * The part of a conversation that led to a reply: the prompt of its turn, the steps up to the
 * call that wrote the reply, and what came right after it.
 */
export function excerpt(entries: readonly TranscriptEntry[], at: number, budget = EXCERPT_BUDGET): string {
  let start = at;
  while (start > 0 && !isPrompt(entries[start]!)) start--;
  let end = at + 1;
  let texts = 0;
  // After the reply: its result and the agent's next words, until the next prompt.
  while (end < entries.length && !isPrompt(entries[end]!) && texts < 2 && end - at <= 12) {
    if (blocks(entries[end]!).some((b) => b.type === 'text' && entries[end]!.type === 'assistant')) texts++;
    end++;
  }
  const mark = toolUses(entries[at]!).find(() => true)?.id ?? null;
  const prompt = isPrompt(entries[start]!) ? renderEntry(entries[start]!, null) : [];
  const steps = entries
    .slice(isPrompt(entries[start]!) ? start + 1 : start, end)
    .map((e) => renderEntry(e, mark))
    .filter((s) => s.length > 0);
  // Keep the steps closest to the reply within the budget.
  let size = prompt.join('\n').length;
  let first = steps.length;
  while (first > 0 && size + steps[first - 1]!.join('\n').length <= budget) size += steps[--first]!.join('\n').length;
  const lines = [...prompt];
  if (first > 0) lines.push(`- (… ${first} earlier step(s) of this turn left out)`);
  lines.push(...steps.slice(first).flat());
  const skill = entries[at]!.attributionSkill;
  const usage = turnUsage(entries.slice(start, end));
  if (skill) lines.push(`- Skill in use: ${skill}`);
  if (usage) lines.push(`- This turn up to there: ${usage}`);
  return lines.join('\n');
}

export interface ConversationResult {
  text: string;
  /** Sessions looked for, and whether at least one conversation was found. */
  sessions: string[];
  available: boolean;
  /** Replies linked to a conversation: none means there was nothing to look for. */
  linked: number;
}

/** Reads back the conversations of a thread's agent replies, as text for the retro's analysis. */
export async function threadConversations(
  thread: ThreadHistory,
  claudeDir: string,
  read: (file: string) => Promise<string> = (f) => readFile(f, 'utf8'),
): Promise<ConversationResult> {
  const replies = linkedReplies(thread);
  const sessions = [...new Set(replies.map((r) => r.session))];
  const head = `# The agent's conversation for thread ${thread.id}`;
  if (replies.length === 0)
    return {
      text:
        `${head}\n\nNo conversation is linked to this thread: its replies were written before Local Review recorded ` +
        "the agent's session, or by an agent that does not give it. Analyse it from the thread alone.",
      sessions,
      available: false,
      linked: 0,
    };
  const parsed = new Map<string, TranscriptEntry[]>();
  const parts: string[] = [];
  let found = 0;
  for (const reply of replies) {
    const title = `## Reply of ${reply.at} — session ${reply.session}`;
    const files = await transcriptsOf(claudeDir, reply.session);
    if (files.length === 0) {
      parts.push(
        `${title}\n\nNo longer available: Claude Code deletes its conversations after 30 days by default ` +
          '(the cleanupPeriodDays setting), and keeps them only on the machine where they ran. Analyse this reply from the thread alone.',
      );
      continue;
    }
    found++;
    let shown = false;
    for (const file of files) {
      if (!parsed.has(file)) parsed.set(file, parseTranscript(await read(file).catch(() => '')));
      const entries = parsed.get(file)!;
      const at = findReply(entries, reply, thread.id);
      if (at < 0) continue;
      parts.push(`${title}\n\nTranscript: ${file}\n\n${excerpt(entries, at)}`);
      shown = true;
      break;
    }
    if (!shown)
      parts.push(
        `${title}\n\nThe conversation exists (${files[0]}), but this reply was not found in it: read it there if needed.`,
      );
  }
  const n = replies.length;
  return {
    text: [
      head,
      `${n} agent repl${n === 1 ? 'y' : 'ies'} linked to a conversation, ${found} still available.`,
      ...parts,
    ].join('\n\n'),
    sessions,
    available: found > 0,
    linked: n,
  };
}

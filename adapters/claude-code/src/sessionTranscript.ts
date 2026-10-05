import { basename } from 'node:path';
import { cut, readJsonl, subagentFiles, textOf, toolSummary } from './sessionAnalytics';

/**
 * A Claude Code session as its report's writer reads it: one text file per conversation (the session,
 * each sub-agent), one line per step, each starting with its line number in the records and its
 * `uuid`, so that a moment pointed at by the analytics is found with a search, with what led to it and
 * what followed. Long texts are cut, and secrets masked: the writer never reads the records themselves.
 */

/** Characters kept of a tool's result, of the agent's texts, and of the user's messages. */
const WIDTH = { result: 500, agent: 1500, user: 3000 } as const;

type Json = Record<string, unknown>;
const isRecord = (x: unknown): x is Json => typeof x === 'object' && x !== null && !Array.isArray(x);
const flat = (s: string) => s.replace(/\s*\n\s*/g, ' ⏎ ');
/** A value as text: itself when it is one, else its JSON. */
const asText = (x: unknown): string => (typeof x === 'string' ? x : x == null ? '' : JSON.stringify(x));

/** One line of the records, readable; empty when it shows nothing worth reading. */
export function renderLine(e: Json): string[] {
  const t = e.type;
  const time = typeof e.timestamp === 'string' ? e.timestamp.slice(11, 19) : '';
  const m = isRecord(e.message) ? e.message : {};
  const out: string[] = [];
  if (t === 'assistant') {
    for (const b of Array.isArray(m.content) ? m.content.filter(isRecord) : []) {
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim())
        out.push(`[${time}] AGENT: ${flat(cut(b.text, WIDTH.agent))}`);
      else if (b.type === 'tool_use')
        out.push(`[${time}] AGENT → ${String(b.name)}: ${flat(toolSummary(String(b.name), b.input))}`);
    }
  } else if (t === 'user') {
    const content = m.content;
    const results = Array.isArray(content) ? content.filter((b) => isRecord(b) && b.type === 'tool_result') : [];
    if (results.length) {
      for (const b of results as Json[]) {
        const body = typeof b.content === 'string' ? b.content : textOf(b.content);
        out.push(`[${time}]   ← ${b.is_error ? 'ERROR' : 'result'}: ${flat(cut(body, WIDTH.result))}`);
      }
      if (typeof e.toolDenialKind === 'string')
        out.push(`[${time}]   ← REFUSED (${e.toolDenialKind}) ${flat(cut(e.userFeedback, 300))}`);
    } else {
      const who = isRecord(e.origin) && typeof e.origin.kind === 'string' ? e.origin.kind : 'human';
      out.push(`[${time}] USER (${who}): ${flat(cut(textOf(content), WIDTH.user))}`);
    }
  } else if (t === 'attachment') {
    const a = isRecord(e.attachment) ? e.attachment : {};
    if (a.type === 'hook_success' || a.type === 'hook_non_blocking_error' || a.type === 'hook_additional_context')
      out.push(`[${time}]   (hook ${String(a.hookName)}: ${flat(cut(asText(a.stdout ?? a.content), 200))})`);
    else if (a.type === 'edited_text_file')
      out.push(`[${time}]   (file changed outside the agent: ${String(a.filename)})`);
    else if (a.type === 'queued_command')
      out.push(`[${time}]   (message sent while the agent worked: ${flat(cut(asText(a.prompt), 300))})`);
  } else if (t === 'system' && ['compact_boundary', 'away_summary', 'local_command'].includes(String(e.subtype)))
    out.push(`[${time}]   (system ${String(e.subtype)}: ${flat(cut(asText(e.content), 300))})`);
  return out;
}

export interface Transcript {
  /** `main`, or the sub-agent's id. */
  agent: string;
  /** The name of its text file. */
  name: string;
  text: string;
}

/** The readable conversations of a session (itself, then its sub-agents), and every `uuid` of its records. */
export async function renderSession(sessionFile: string): Promise<{ transcripts: Transcript[]; uuids: Set<string> }> {
  const uuids = new Set<string>();
  const files = [{ id: 'main', file: sessionFile }, ...(await subagentFiles(sessionFile))];
  const transcripts: Transcript[] = [];
  for (const f of files) {
    const lines: string[] = [];
    for (const { n, e } of await readJsonl(f.file)) {
      const uuid = typeof e.uuid === 'string' ? e.uuid : '';
      if (uuid) uuids.add(uuid);
      const shown = renderLine(e);
      if (shown.length) lines.push(`L${n} ${uuid || '-'} ${shown.join(' | ')}`);
    }
    transcripts.push({
      agent: f.id,
      name: f.id === 'main' ? 'conversation-main.txt' : `conversation-${basename(f.file, '.jsonl')}.txt`,
      text: lines.join('\n') + '\n',
    });
  }
  return { transcripts, uuids };
}

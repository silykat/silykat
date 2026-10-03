import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAnchorContext, RetroBook, SessionRegistry, Store, type Anchor } from '@local-review/core';
import { handleHook, replyCall, type HookDeps } from '../src/hook';
import { runRetroCli } from '../src/retroCli';
import {
  excerpt,
  findReply,
  parseTranscript,
  threadConversations,
  transcriptsOf,
  type TranscriptEntry,
} from '../src/retroConversation';

let base: string;
let claudeDir: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'lr-conversation-')));
  claudeDir = join(base, 'claude');
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function put(path: string, content: string) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
}

const SESSION = 'e3244e92-00ec-444d-8321-e34fa73fccbf';

// Entries shaped like Claude Code's transcripts (2.1.288): one content block per line.
const prompt = (text: string, at: string): TranscriptEntry => ({
  type: 'user',
  timestamp: at,
  message: { role: 'user', content: text },
});
const said = (text: string, at: string, id = 'msg_1'): TranscriptEntry => ({
  type: 'assistant',
  timestamp: at,
  message: {
    id,
    role: 'assistant',
    content: [{ type: 'text', text }],
    usage: { input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 50 },
  },
});
const call = (
  id: string,
  name: string,
  input: Record<string, unknown>,
  at: string,
  msg = 'msg_2',
): TranscriptEntry => ({
  type: 'assistant',
  timestamp: at,
  attributionSkill: 'local-review:review',
  message: {
    id: msg,
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input }],
    usage: { input_tokens: 5, cache_read_input_tokens: 2000, output_tokens: 20 },
  },
});
const result = (id: string, content: unknown, at: string, isError = false): TranscriptEntry => ({
  type: 'user',
  timestamp: at,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
});

function transcript(threadId: string): TranscriptEntry[] {
  return [
    { type: 'queue-operation', timestamp: '2026-10-03T10:00:00.000Z' },
    prompt(
      `<channel source="local-review" threads="${threadId}">The user published comments</channel>`,
      '2026-10-03T10:00:00.000Z',
    ),
    {
      type: 'user',
      isMeta: true,
      timestamp: '2026-10-03T10:00:00.100Z',
      message: { content: 'Base directory for this skill' },
    },
    {
      type: 'assistant',
      timestamp: '2026-10-03T10:00:01.000Z',
      message: { id: 'msg_1', content: [{ type: 'thinking' }] },
    },
    said('I read the thread first.', '2026-10-03T10:00:01.500Z'),
    call('toolu_show', 'Bash', { command: `lr show ${threadId}` }, '2026-10-03T10:00:02.000Z'),
    result('toolu_show', 'Use integer cents, not floats.', '2026-10-03T10:00:03.000Z'),
    call('toolu_read', 'Read', { file_path: '/work/api/src/money.ts' }, '2026-10-03T10:00:04.000Z', 'msg_3'),
    result('toolu_read', [{ type: 'text', text: 'export const total = 1.5;' }], '2026-10-03T10:00:05.000Z'),
    call('toolu_edit', 'Edit', { file_path: '/work/api/src/money.ts' }, '2026-10-03T10:00:06.000Z', 'msg_4'),
    result('toolu_edit', 'oops', '2026-10-03T10:00:07.000Z', true),
    call(
      'toolu_reply',
      'Bash',
      { command: `lr reply ${threadId} --agent Claude --body "Done"` },
      '2026-10-03T10:00:08.000Z',
      'msg_5',
    ),
    result('toolu_reply', `Replied on ${threadId} (status: addressed).`, '2026-10-03T10:00:09.000Z'),
    said('I switched the amounts to cents.', '2026-10-03T10:00:10.000Z', 'msg_6'),
    prompt('Next request', '2026-10-03T10:05:00.000Z'),
    said('Something else entirely.', '2026-10-03T10:05:01.000Z', 'msg_7'),
  ];
}

const jsonl = (entries: TranscriptEntry[]) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';

describe('noting the tool call that runs lr reply', () => {
  it('recognises lr reply in the usual shapes of a command, and nothing else', () => {
    const at = (command: string, id = 'toolu_1') => replyCall({ tool_use_id: id, tool_input: { command } });
    expect(at('lr reply t_1 --agent Claude --body -')).toEqual({
      message: 'toolu_1',
      command: 'lr reply t_1 --agent Claude --body -',
    });
    expect(at("cd /work && LR_AGENT=Claude lr reply t_1 --body 'x'")).not.toBeNull();
    expect(at('/plugin/bin/lr reply t_1 --body-file /tmp/a.md')).not.toBeNull();
    expect(at('lr show t_1')).toBeNull();
    expect(at('echo "lr reply t_1"')).toBeNull();
    expect(at('lr reply t_1', '../escape')).toBeNull();
    expect(replyCall({ tool_use_id: 'toolu_1', tool_input: {} })).toBeNull();
  });

  it('keeps the call while lr runs (PreToolUse), and forgets it after (PostToolUse)', async () => {
    const home = join(base, 'machine');
    const registry = new SessionRegistry(home, () => true);
    const deps: HookDeps = {
      registry,
      claudePid: async () => null,
      commandLine: async () => null,
      gitBranch: async () => null,
      topicOf: async (path) => ({ kind: 'path', path }),
      gitWorktreeOf: async () => null,
      filesChangedSince: async () => [],
      now: () => new Date('2026-10-03T10:00:00.000Z'),
    };
    const input = {
      session_id: 's1',
      cwd: base,
      tool_name: 'Bash',
      tool_use_id: 'toolu_42',
      tool_input: { command: 'lr reply t_1 --agent Claude --body Done' },
    };
    await handleHook({ ...input, hook_event_name: 'PreToolUse' }, deps);
    expect(await registry.calls('s1')).toEqual([
      { message: 'toolu_42', command: 'lr reply t_1 --agent Claude --body Done', at: '2026-10-03T10:00:00.000Z' },
    ]);
    await handleHook({ ...input, hook_event_name: 'PostToolUse' }, deps);
    expect(await registry.calls('s1')).toEqual([]);

    // Any other command leaves no call behind.
    await handleHook({ ...input, hook_event_name: 'PreToolUse', tool_input: { command: 'npm test' } }, deps);
    expect(await registry.calls('s1')).toEqual([]);
  });

  it('forgets the call of a command that failed (PostToolUseFailure), so that no later reply takes it', async () => {
    const registry = new SessionRegistry(join(base, 'machine'), () => true);
    const deps: HookDeps = {
      registry,
      claudePid: async () => null,
      commandLine: async () => null,
      gitBranch: async () => null,
      topicOf: async (path) => ({ kind: 'path', path }),
      gitWorktreeOf: async () => null,
      filesChangedSince: async () => [],
      now: () => new Date('2026-10-03T10:00:00.000Z'),
    };
    const input = {
      session_id: 's1',
      cwd: base,
      tool_name: 'Bash',
      tool_use_id: 'toolu_refused',
      tool_input: { command: 'lr reply t_1 --body Done' },
    };
    await handleHook({ ...input, hook_event_name: 'PreToolUse' }, deps);
    expect(await registry.calls('s1')).toHaveLength(1);
    expect(await handleHook({ ...input, hook_event_name: 'PostToolUseFailure' }, deps)).toBeUndefined();
    expect(await registry.calls('s1')).toEqual([]);
    expect(await registry.takeNote('s1', 'bash-toolu_refused')).toBeUndefined();

    // Another tool's failure is not ours to handle.
    expect(await handleHook({ ...input, tool_name: 'Edit', hook_event_name: 'PostToolUseFailure' }, deps)).toBe(
      undefined,
    );
  });
});

describe("reading back Claude Code's conversation", () => {
  it('finds the transcripts of a session, sub-agents included, and nothing for an unsafe id', async () => {
    await put(join(claudeDir, 'projects', '-work-api', `${SESSION}.jsonl`), '');
    await put(join(claudeDir, 'projects', '-work-api', SESSION, 'subagents', 'agent-a1.jsonl'), '');
    await put(join(claudeDir, 'projects', '-work-api', SESSION, 'subagents', 'notes.txt'), '');
    await put(join(claudeDir, 'projects', '-elsewhere', 'other.jsonl'), '');
    expect(await transcriptsOf(claudeDir, SESSION)).toEqual([
      join(claudeDir, 'projects', '-work-api', `${SESSION}.jsonl`),
      join(claudeDir, 'projects', '-work-api', SESSION, 'subagents', 'agent-a1.jsonl'),
    ]);
    expect(await transcriptsOf(claudeDir, '../../etc')).toEqual([]);
    expect(await transcriptsOf(join(base, 'none'), SESSION)).toEqual([]);
  });

  it('locates a reply by its tool call, else by the latest lr command naming the thread before it', () => {
    const entries = transcript('t_1');
    expect(
      findReply(entries, { session: SESSION, message: 'toolu_reply', at: '2026-10-03T10:00:09.000Z' }, 't_1'),
    ).toBe(11);
    // Without the message (or one not in this file): the lr command naming the thread.
    expect(findReply(entries, { session: SESSION, at: '2026-10-03T10:00:09.000Z' }, 't_1')).toBe(11);
    expect(findReply(entries, { session: SESSION, message: 'toolu_gone', at: '2026-10-03T09:59:03.000Z' }, 't_1')).toBe(
      5,
    );
    expect(findReply(entries, { session: SESSION, at: '2026-10-03T09:00:00.000Z' }, 't_1')).toBe(-1);
    expect(findReply(entries, { session: SESSION, at: '2026-10-03T10:00:09.000Z' }, 't_2')).toBe(-1);
  });

  it('shows the prompt of the turn, the steps up to the reply and right after it, the skill and the tokens', () => {
    const text = excerpt(transcript('t_1'), 11);
    expect(text).toContain('- **Prompt** (10:00:00): <channel source="local-review" threads="t_1">');
    expect(text).not.toContain('Base directory for this skill');
    expect(text).toContain('- **Claude** (10:00:01): I read the thread first.');
    expect(text).toContain('- → Bash: lr show t_1');
    expect(text).toContain('  - result: Use integer cents, not floats.');
    expect(text).toContain('- → Read: /work/api/src/money.ts');
    expect(text).toContain('  - result: export const total = 1.5;');
    expect(text).toContain('  - error: oops');
    expect(text).toContain('- **This call wrote the reply** → Bash: lr reply t_1 --agent Claude --body "Done"');
    expect(text).toContain('- **Claude** (10:00:10): I switched the amounts to cents.');
    expect(text).not.toContain('Something else entirely');
    expect(text).toContain('- Skill in use: local-review:review');
    // 6 model calls (msg_1 to msg_6), each counted once although split in several lines.
    expect(text).toContain(
      '- This turn up to there: 6 model call(s), 10040 tokens in (10000 read from the cache), 180 out',
    );
  });

  it('keeps the steps closest to the reply when the turn is long', () => {
    const entries = transcript('t_1');
    const text = excerpt(entries, 11, 300);
    expect(text).toContain('- **Prompt**');
    expect(text).toMatch(/- \(… \d+ earlier step\(s\) of this turn left out\)/);
    expect(text).toContain('**This call wrote the reply**');
    expect(text).not.toContain('I read the thread first.');
    expect(excerpt(entries, 11, 300).length).toBeLessThan(excerpt(entries, 11).length);
    // A long text is cut.
    const long = excerpt(
      [
        prompt('x'.repeat(5000), '2026-10-03T10:00:00.000Z'),
        call('t', 'Bash', { command: 'lr reply t_1' }, '2026-10-03T10:00:01.000Z'),
      ],
      1,
    );
    expect(long).toContain('… (3000 more characters)');
  });

  it('renders every kind of step in one line, and skips what a retro does not need', () => {
    const entries: TranscriptEntry[] = [
      { type: 'attachment' },
      call('t1', 'Grep', { pattern: 'cents', path: 'src' }, '2026-10-03T10:00:01.000Z', 'm1'),
      call('t2', 'Glob', { pattern: '**/*.ts' }, '2026-10-03T10:00:01.000Z', 'm1'),
      call('t3', 'Agent', { description: 'Explore the code', prompt: 'long' }, '2026-10-03T10:00:01.000Z', 'm1'),
      call('t4', 'WebFetch', { url: 'https://example.com' }, '2026-10-03T10:00:01.000Z', 'm1'),
      call('t5', 'TodoWrite', { todos: [1] }, '2026-10-03T10:00:01.000Z', 'm1'),
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't6' }] } },
      result('t5', { odd: true }, '2026-10-03T10:00:02.000Z'),
      { type: 'assistant', message: { content: [{ type: 'text', text: '  ' }] } },
      { type: 'user', message: { content: [{ type: 'text', text: 'A question in blocks' }] } },
    ];
    const text = excerpt(entries, 6);
    expect(text.split('\n')).toEqual([
      '- → Grep: cents in src',
      '- → Glob: **/*.ts',
      '- → Agent: Explore the code',
      '- → WebFetch: https://example.com',
      '- → TodoWrite: {"todos":[1]}',
      '- **This call wrote the reply** → tool: {}',
      '  - result: (empty)',
      '- This turn up to there: 1 model call(s), 2005 tokens in (2000 read from the cache), 20 out',
    ]);
    // A prompt made of text blocks starts the turn.
    expect(excerpt([...entries.slice(-1), said('Answer', '2026-10-03T10:00:03.000Z')], 1)).toContain(
      '- **Prompt** (): A question in blocks',
    );
  });

  it('goes on when a transcript cannot be read', async () => {
    await put(join(claudeDir, 'projects', '-work-api', `${SESSION}.jsonl`), '');
    const thread = {
      id: 't_1',
      conversation: [{ kind: 'comment', author: 'agent', session: { id: SESSION }, at: '2026-10-03T10:00:00.000Z' }],
    } as never;
    const res = await threadConversations(thread, claudeDir, () => Promise.reject(new Error('EACCES')));
    expect(res.available).toBe(true);
    expect(res.text).toContain('this reply was not found in it');
  });

  it('skips the lines it cannot read', () => {
    expect(parseTranscript('{"type":"user"}\nnot json\n[1]\n\n{"type":"assistant"')).toEqual([{ type: 'user' }]);
  });
});

const CODE = 'export const total = 1.5;';
const anchor = (): Anchor => ({
  path: 'src/money.ts',
  source: 'worktree',
  ref: null,
  sha: null,
  ...buildAnchorContext(CODE, { startLine: 1, endLine: 1 }),
});

describe('lr-retro conversation', () => {
  async function retro() {
    const root = join(base, 'work');
    const store = new Store(join(root, 'api'));
    const linked = await store.createThread(anchor(), { author: 'user', body: 'Use cents', reviewId: null });
    await store.addComment(linked.id, {
      author: 'agent',
      agent: 'Claude',
      body: 'Done',
      reviewId: null,
      session: { id: SESSION, message: 'toolu_reply' },
    });
    const gone = await store.createThread(anchor(), { author: 'user', body: 'Rename it', reviewId: null });
    await store.addComment(gone.id, {
      author: 'agent',
      agent: 'Claude',
      body: 'Renamed',
      reviewId: null,
      session: { id: 'old-session' },
    });
    const unlinked = await store.createThread(anchor(), { author: 'user', body: 'Why?', reviewId: null });
    await store.addComment(unlinked.id, { author: 'agent', agent: 'Claude', body: 'Because', reviewId: null });
    const book = new RetroBook(root);
    const r = await book.start({
      root,
      since: null,
      until: new Date().toISOString(),
      stores: [{ root: join(root, 'api'), origin: 'below', threads: 3, bytes: 1 }],
      threads: [linked.id, gone.id, unlinked.id],
      bytes: 1,
    });
    return { root, book, id: r.id, linked: linked.id, gone: gone.id, unlinked: unlinked.id };
  }

  async function run(args: string[]) {
    let out = '';
    let err = '';
    const code = await runRetroCli(args, {
      cwd: base,
      env: { HOME: join(base, 'home'), LOCAL_REVIEW_HOME: join(base, 'machine'), CLAUDE_CONFIG_DIR: claudeDir },
      out: (t) => (out += t + '\n'),
      err: (t) => (err += t + '\n'),
    });
    return { code, out, err };
  }

  it('reads back the conversation of a reply, and records in the retro that it did', async () => {
    const { root, book, id, linked } = await retro();
    await put(join(claudeDir, 'projects', '-work-api', `${SESSION}.jsonl`), jsonl(transcript(linked)));
    const r = await run(['conversation', id, linked, '--root', root]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`# The agent's conversation for thread ${linked}`);
    expect(r.out).toContain('1 agent reply linked to a conversation, 1 still available.');
    expect(r.out).toContain(`session ${SESSION}`);
    expect(r.out).toContain('**This call wrote the reply** → Bash: lr reply');
    expect((await book.get(id)).conversations[linked]).toMatchObject({ sessions: [SESSION], available: true });
  });

  it('finds a reply written by a sub-agent in its transcript', async () => {
    const { root, id, linked } = await retro();
    await put(
      join(claudeDir, 'projects', '-work-api', `${SESSION}.jsonl`),
      jsonl([prompt('Handle my comments', '2026-10-03T09:00:00.000Z')]),
    );
    await put(
      join(claudeDir, 'projects', '-work-api', SESSION, 'subagents', 'agent-1.jsonl'),
      jsonl(transcript(linked)),
    );
    const r = await run(['conversation', id, linked, '--root', root]);
    expect(r.out).toContain('subagents/agent-1.jsonl');
    expect(r.out).toContain('**This call wrote the reply**');
  });

  it('says when the conversation exists but the reply is not in it', async () => {
    const { root, id, linked } = await retro();
    await put(
      join(claudeDir, 'projects', '-work-api', `${SESSION}.jsonl`),
      jsonl([prompt('Unrelated', '2026-10-03T09:00:00.000Z')]),
    );
    const r = await run(['conversation', id, linked, '--root', root]);
    expect(r.out).toContain('The conversation exists');
    expect(r.out).toContain('this reply was not found in it');
  });

  it('says when the conversation is no longer available, and records it', async () => {
    const { root, book, id, gone } = await retro();
    const r = await run(['conversation', id, gone, '--root', root]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('0 still available');
    expect(r.out).toContain('No longer available: Claude Code deletes its conversations after 30 days by default');
    expect((await book.get(id)).conversations[gone]).toMatchObject({ sessions: ['old-session'], available: false });
  });

  it('says when no conversation is linked, without recording anything', async () => {
    const { root, book, id, unlinked } = await retro();
    const r = await run(['conversation', id, unlinked, '--root', root]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('No conversation is linked to this thread');
    expect((await book.get(id)).conversations).toEqual({});
  });

  it('refuses a thread that is not in the retro, or no thread at all', async () => {
    const { root, id } = await retro();
    expect((await run(['conversation', id, 't_unknown', '--root', root])).err).toContain(
      'is not one of the threads of retro',
    );
    expect((await run(['conversation', id, '--root', root])).err).toContain('missing <thread-id>');
  });

  it('still reads back for a finished retro, without recording', async () => {
    const { root, book, id, linked } = await retro();
    await book.record(id, [{ type: 'retro.finished' }]);
    await put(join(claudeDir, 'projects', '-work-api', `${SESSION}.jsonl`), jsonl(transcript(linked)));
    const r = await run(['conversation', id, linked, '--root', root]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('**This call wrote the reply**');
    expect((await book.get(id)).conversations).toEqual({});
  });

  it('shares the budget of the excerpts among the replies of a thread', async () => {
    const { linked } = await retro();
    const store = new Store(join(base, 'work', 'api'));
    const long = (n: number) => `${'x'.repeat(5000)} ${n}`;
    const entries: TranscriptEntry[] = [];
    for (let round = 1; round <= 3; round++) {
      const t = (s: number) => `2026-10-03T1${round}:00:0${s}.000Z`;
      entries.push(prompt(long(round), t(0)));
      for (let i = 0; i < 6; i++) entries.push(said(long(i), t(1), `msg_${round}_${i}`));
      entries.push(call(`toolu_r${round}`, 'Bash', { command: `lr reply ${linked} --body x` }, t(2), `msg_${round}_c`));
      await store.addComment(linked, {
        author: 'agent',
        agent: 'Claude',
        body: `Round ${round}`,
        reviewId: null,
        session: { id: SESSION, message: `toolu_r${round}` },
      });
    }
    await put(join(claudeDir, 'projects', '-work-api', `${SESSION}.jsonl`), jsonl(entries));
    const thread = (await store.loadHistory()).threads.find((t) => t.id === linked)!;
    const res = await threadConversations(thread, claudeDir);
    expect(res.linked).toBe(4);
    expect((res.text.match(/This call wrote the reply/g) ?? []).length).toBe(3);
    // Four replies share about 12,000 characters (plus their titles and paths).
    expect(res.text.length).toBeLessThan(14_000);
  });

  it('reads a transcript only once for several replies of the same session', async () => {
    const { linked } = await retro();
    const store = new Store(join(base, 'work', 'api'));
    await store.addComment(linked, { author: 'user', body: 'Again', reviewId: null });
    await store.addComment(linked, {
      author: 'agent',
      agent: 'Claude',
      body: 'Again done',
      reviewId: null,
      session: { id: SESSION },
    });
    await put(join(claudeDir, 'projects', '-work-api', `${SESSION}.jsonl`), jsonl(transcript(linked)));
    const thread = (await store.loadHistory()).threads.find((t) => t.id === linked)!;
    let reads = 0;
    const res = await threadConversations(thread, claudeDir, async (f) => {
      reads++;
      const { readFile } = await import('node:fs/promises');
      return readFile(f, 'utf8');
    });
    expect(reads).toBe(1);
    expect(res.linked).toBe(2);
    expect(res.sessions).toEqual([SESSION]);
    expect(res.text).toContain('2 agent replies linked to a conversation, 2 still available.');
  });
});

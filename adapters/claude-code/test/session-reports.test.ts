import { access, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSessionReport, RetroBook, writeConfig, writeSessionReport, type SessionReport } from '@local-review/core';
import type { Runner } from '../src/retroAudit';
import { runRetroCli } from '../src/retroCli';
import { analyseSession, mask, normCommand } from '../src/sessionAnalytics';
import {
  currentSession,
  dropUnknownMoments,
  estimateReports,
  jsonOfAnswer,
  planReports,
  REPORT_COST,
  reportArgs,
  writeReport,
  writeReports,
} from '../src/sessionReports';
import { renderSession } from '../src/sessionTranscript';

let base: string;
let home: string;
let root: string;
let projects: string;
const env = () => ({ HOME: home, LOCAL_REVIEW_HOME: join(base, 'machine') });

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'lr-session-reports-')));
  home = join(base, 'home');
  root = join(base, 'work');
  projects = join(home, '.claude', 'projects', '-work');
  await mkdir(root, { recursive: true });
  await mkdir(projects, { recursive: true });
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const at = (day: number, minute = 0) =>
  `2026-09-${String(day).padStart(2, '0')}T10:${String(minute).padStart(2, '0')}:00.000Z`;

let clock = 0;
/** One line of a Claude Code conversation. */
const line = (type: string, fields: Record<string, unknown> = {}) => ({
  type,
  uuid: `u${++clock}`,
  timestamp: at(20, clock % 60),
  cwd: root,
  gitBranch: 'main',
  version: '2.1.289',
  entrypoint: 'cli',
  ...fields,
});
const prompt = (text: string, fields: Record<string, unknown> = {}) =>
  line('user', { message: { role: 'user', content: text }, ...fields });
const toolUse = (id: string, name: string, input: Record<string, unknown>, msg = `m${clock}`) =>
  line('assistant', {
    message: {
      id: msg,
      model: 'claude-opus',
      content: [{ type: 'tool_use', id, name, input }],
      usage: { input_tokens: 10 },
    },
  });
const toolResult = (
  id: string,
  content: string,
  fields: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) => line('user', { message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...fields }] }, ...extra });

/** A session of the project: a conversation, and its sub-agents when given. */
async function session(
  id: string,
  lines: object[],
  subagents: Record<string, { meta?: object; lines: object[] }> = {},
) {
  const file = join(projects, `${id}.jsonl`);
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  for (const [agentPath, a] of Object.entries(subagents)) {
    const f = join(projects, id, 'subagents', `${agentPath}.jsonl`);
    await mkdir(join(f, '..'), { recursive: true });
    await writeFile(f, a.lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    if (a.meta) await writeFile(f.replace(/\.jsonl$/, '.meta.json'), JSON.stringify(a.meta));
  }
  return file;
}

/** A session that holds every kind of signal. */
async function richSession(id = 's-rich') {
  clock = 0;
  return session(
    id,
    [
      line('attachment', { attachment: { type: 'skill_listing', names: ['review', 'deploy'] } }),
      line('attachment', {
        attachment: { type: 'instructions', files: [{ path: '/w/CLAUDE.md', type: 'Project', content: 'Rules' }] },
      }),
      prompt('<command-name>/local-review:review</command-name>'),
      prompt('Fix the dates, token=abcd1234secret'),
      toolUse('t1', 'Bash', { command: 'cd /w && source ~/.nvm/nvm.sh >/dev/null && npm test' }),
      toolResult('t1', 'FAIL', { is_error: true }),
      toolUse('t2', 'Bash', { command: 'source ~/.nvm/nvm.sh >/dev/null && npm test' }),
      toolResult('t2', 'FAIL again', { is_error: true }),
      toolUse('t3', 'Bash', { command: "sed -i '' s/a/b/ dates.ts" }),
      toolResult('t3', ''),
      line('attachment', { attachment: { type: 'edited_text_file', filename: '/w/dates.ts' } }),
      line('attachment', { attachment: { type: 'edited_text_file', filename: '/w/other.ts' } }),
      prompt('No, not like this: keep UTC', { gitBranch: 'feat/utc' }),
      toolUse('t4', 'Bash', { command: 'git commit -m "fix: dates"' }),
      toolResult('t4', '[main abc] fix'),
      toolUse('t5', 'AskUserQuestion', { questions: [{ question: 'Which zone?' }] }),
      toolResult('t5', 'UTC'),
      toolUse('t6', 'Agent', { description: 'Check the tests', subagent_type: 'Explore' }),
      toolResult('t6', 'done', {}, { toolUseResult: { status: 'completed', totalTokens: 5 } }),
      toolUse('t7', 'Skill', { skill: 'deploy' }),
      toolResult('t7', 'ok'),
      line('user', { message: { content: '[Request interrupted by user]' } }),
      line('pr-link', { prNumber: 7, prRepository: 'me/app' }),
      line('pr-link', { prNumber: 7, prRepository: 'me/app' }),
      line('system', { subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 100 } }),
      line('attachment', { attachment: { type: 'queued_command', prompt: 'also the docs' } }),
      prompt('<channel source="local-review">2 comments</channel>', { origin: { kind: 'channel' } }),
      line('ai-title', { aiTitle: 'Fix the dates' }),
      'not json' as unknown as object,
    ],
    {
      'agent-a1': {
        meta: { agentType: 'Explore', description: 'Check the tests', toolUseId: 't6' },
        lines: [toolUse('x1', 'Read', { file_path: '/w/a.ts' }), toolResult('x1', 'nope', { is_error: true })],
      },
      'workflows/wf_1/agent-w1': { lines: [prompt('Write the docs')] },
    },
  );
}

describe('the analytics of a Claude Code session (without a model)', () => {
  it('finds the signals of the session and of its sub-agents, each pointing at a moment', async () => {
    const a = await analyseSession(await richSession());
    expect(a.session_id).toBe('s-rich');
    expect(a.cwd).toBe(root);
    expect(a.title).toBe('Fix the dates');
    expect(a.branches).toEqual(['main', 'feat/utc']);
    expect(a.counts.typed_prompts).toBe(2);
    expect(a.counts.lines).toBe(28 + 2 + 1); // the unreadable line is skipped
    expect(a.agents.map((x) => [x.id, x.type, x.workflow])).toEqual([
      ['main', 'main', false],
      ['a1', 'Explore', false],
      ['w1', null, true],
    ]);
    const s = a.signals;
    // Every family and signal is there, even empty.
    expect(s.setup?.commands).toEqual([]);
    expect(s.cost?.api_errors).toEqual([]);
    expect(s.collaboration?.corrections?.map((o) => o.text)).toEqual(['No, not like this: keep UTC']);
    expect(s.collaboration?.friction?.map((o) => o.kind)).toEqual(['interruption']);
    expect(s.collaboration?.user_edits?.map((o) => [o.kind, o.file])).toEqual([
      ['file_changed_by_agent_command', '/w/dates.ts'],
      ['file_edited_outside_agent', '/w/other.ts'],
    ]);
    expect(s.collaboration?.agent_questions?.[0]).toMatchObject({ agent: 'main', questions: ['Which zone?'] });
    expect(s.tools?.tool_errors?.map((o) => o.agent)).toEqual(['main', 'main', 'a1']);
    // The setup steps of a command do not hide that it fails again and again.
    expect(s.tools?.repeated_failures).toEqual([{ command: 'npm test', failures: 2, uuids: ['u6', 'u8'] }]);
    expect(s.delivery?.git?.map((o) => o.operation)).toEqual(['git commit']);
    expect(s.delivery?.pull_requests).toEqual([expect.objectContaining({ pr: 7, repo: 'me/app', links: 2 })]);
    expect(s.delivery?.local_review_messages).toHaveLength(1);
    expect(s.setup?.skills?.map((o) => [o.kind, o.skill])).toEqual([
      ['typed_by_user', 'local-review:review'],
      ['called_by_agent', 'deploy'],
    ]);
    expect(s.setup?.subagents?.map((o) => o.kind)).toEqual(['launched', 'result']);
    expect(a.setup.skills_available_never_called).toEqual(['review']);
    expect(a.setup.instructions_loaded['/w/CLAUDE.md']).toMatchObject({ type: 'Project', bytes: 5 });
    expect(s.workflow?.context_pressure?.[0]).toMatchObject({ kind: 'compaction', trigger: 'auto' });
    expect(s.workflow?.autonomy?.[0]).toMatchObject({ kind: 'message_while_working', text: 'also the docs' });
    expect(s.workflow?.handoff?.[0]).toMatchObject({ kind: 'last_prompt_of_session' });
    // A prompt that holds a secret: masked.
    expect(s.workflow?.repeated_requests?.[0]).toMatchObject({ uuid: 'u4', line: 4, text: 'Fix the dates, [secret]' });
    expect(a.cost.tokens_by_model['claude-opus']).toEqual({ input_tokens: 80 }); // sub-agents included
  });

  it('reads every kind of line, and lines with missing fields', async () => {
    clock = 0;
    const file = await session('s-all', [
      prompt('<command-name>/clear</command-name>'),
      line('custom-title', { customTitle: 'Dates' }),
      line('permission-mode', { permissionMode: 'plan' }),
      line('cost-state', { totalCostUSD: 1.5, totalDuration: 10 }),
      line('system', { subtype: 'turn_duration', durationMs: 1200 }),
      line('system', { subtype: 'away_summary' }),
      line('system', { subtype: 'stop_hook_summary', hookCount: 2, hookErrors: ['x'], preventedContinuation: true }),
      line('system', { subtype: 'local_command', content: '<command-name>/model</command-name>' }),
      line('system', { subtype: 'compact_boundary' }),
      line('attachment', { attachment: { type: 'nested_memory', path: '/w/api/CLAUDE.md', content: { a: 1 } } }),
      line('attachment', { attachment: { type: 'instructions', files: [{ path: '/w/x.md', content: ['list'] }] } }),
      line('attachment', {
        attachment: { type: 'hook_success', hookName: 'lr', hookEvent: 'PostToolUse', exitCode: 0, stdout: 'ok' },
      }),
      line('attachment', { attachment: { type: 'hook_non_blocking_error', hookName: 'lr', stderr: 'boom' } }),
      line('attachment', { attachment: { type: 'hook_additional_context', hookName: 'lr', content: { x: 1 } } }),
      line('attachment', { attachment: { type: 'hook_additional_context', content: 'Retro due' } }),
      line('attachment', { attachment: { type: 'plan_mode' } }),
      line('attachment', { attachment: { type: 'queued_command', prompt: { complex: true } } }),
      line('attachment', { attachment: { type: 'edited_text_file' } }),
      line('attachment', {}),
      prompt('Plan the dates', { promptSource: 'typed' }),
      line('assistant', { attributionSkill: 'review', isApiErrorMessage: true, apiErrorStatus: 529, message: {} }),
      line('assistant', { message: { id: 'same', content: [{ type: 'text', text: 'hi' }, 'odd'], usage: { x: 1.5 } } }),
      line('assistant', { message: { id: 'same', model: 'claude-opus', usage: { input_tokens: 3 } } }),
      toolUse('e1', 'Edit', { file_path: '/w/a.ts' }),
      toolResult('e1', 'ok', {}, { toolUseResult: { userModified: true, filePath: '/w/a.ts' } }),
      toolUse('b1', 'Bash', { command: 'npm run long' }),
      toolResult('b1', 'stopped', {}, { toolUseResult: { interrupted: true } }),
      toolUse('b2', 'Bash', { command: 'rm -rf /tmp/x' }),
      toolResult('b2', 'refused', { is_error: true }, { toolDenialKind: 'user-rejected', userFeedback: 'No!' }),
      toolUse('b3', 'Bash', { command: 'curl x' }),
      toolResult('b3', 'blocked', { is_error: true }, { toolDenialKind: 'auto-mode' }),
      line('user', { toolDenialKind: 'rule', message: { content: [] } }),
      toolUse('k1', 'Skill', { skill: 'ship' }),
      toolResult('k1', 'no', {}, { toolUseResult: { success: false, commandName: 'ship' } }),
      toolUse('q1', 'AskUserQuestion', {}),
      toolResult(
        'q1',
        [{ type: 'text', text: 'UTC' }] as unknown as string,
        {},
        { toolUseResult: { answers: { q: 'UTC' } } },
      ),
      toolUse('g1', 'Grep', { pattern: 'TODO' }),
      toolResult('g1', [{ type: 'text', text: 'no match' }] as unknown as string, { is_error: true }),
      toolResult('unknown', 'orphan', { is_error: true }),
      toolUse('t1', 'Task', {}),
      toolResult('t1', 'done', {}, { toolUseResult: { status: 'completed' } }),
      toolUse('w1', 'WebFetch', { url: 'https://x' }),
      toolUse('n1', 'Other', {}),
      toolUse('ag', 'Agent', { description: 'Look' }),
      prompt('<command-name>/compact</command-name>'),
      prompt('<command-name>/status</command-name>'),
      prompt('<command-name>/deploy-it</command-name>'),
      prompt('Meta', { isMeta: true }),
      prompt('Summary', { isCompactSummary: true }),
      prompt('<system-reminder>x</system-reminder>'),
      line('user', { message: { content: [{ type: 'text', text: 'From a list' }] } }),
      line('user', {}),
      line('pr-link', {}),
      { type: 'assistant' },
      { type: 'user', message: { content: 'No uuid nor time' } },
    ]);
    const a = await analyseSession(file);
    const s = a.signals;
    expect(a.custom_title).toBe('Dates');
    expect(a.counts).toMatchObject({
      typed_prompts: 3,
      away_summaries: 1,
      turns: 1,
      turn_duration_ms_total: 1200,
      permission_modes: { plan: 1 },
    });
    expect(a.counts.commands).toMatchObject({ model: 1, clear: 1, compact: 1, status: 1, 'deploy-it': 1 });
    expect(a.cost.cost_state).toMatchObject({ totalCostUSD: 1.5, totalDuration: 10, totalLinesAdded: null });
    expect(a.cost.tokens_by_model['?']).toBeUndefined(); // usage that is no integer is not counted
    // A message told in several lines is counted once: its second line (3 tokens) is not added.
    expect(a.cost.tokens_by_model['claude-opus']).toEqual({ input_tokens: 110 });
    expect(a.setup.instructions_loaded['/w/api/CLAUDE.md']).toMatchObject({ type: 'nested' });
    expect(a.setup.skills_active_messages).toEqual({ review: 1 });
    expect(s.workflow?.context_pressure?.map((o) => o.kind)).toEqual([
      'started_by_clear',
      'compaction',
      'compact_command',
    ]);
    expect(s.tools?.hooks?.map((o) => o.kind)).toEqual(['stop', 'output', 'error', 'context', 'context']);
    expect(s.workflow?.autonomy?.map((o) => o.kind)).toEqual(['plan_mode', 'message_while_working']);
    expect(s.collaboration?.user_edits?.map((o) => o.kind)).toEqual([
      'file_edited_outside_agent',
      'proposal_modified_by_user',
    ]);
    expect(s.cost?.api_errors?.[0]).toMatchObject({ status: 529 });
    expect(s.collaboration?.friction?.map((o) => o.kind)).toEqual(['command_interrupted', 'refused_by_user']);
    expect(s.tools?.permission_blocks?.map((o) => o.kind)).toEqual(['auto-mode', 'rule']);
    expect(s.setup?.skills?.map((o) => o.kind)).toEqual(['called_by_agent', 'failed', 'typed_by_user']);
    expect(s.setup?.commands?.map((o) => o.command)).toEqual(['status']);
    expect(s.setup?.subagents?.map((o) => [o.kind, o.subagent_type ?? o.status])).toEqual([
      ['launched', 'general-purpose'],
      ['result', 'completed'],
      ['launched', 'general-purpose'],
    ]);
    expect(s.collaboration?.agent_questions?.map((o) => o.kind ?? 'asked')).toEqual(['asked', 'answers']);
    expect(s.tools?.tool_errors?.map((o) => o.tool)).toEqual(['Bash', 'Bash', 'Grep', '?']);
    expect(s.delivery?.pull_requests).toEqual([expect.objectContaining({ pr: null, links: 1 })]);
    const { transcripts } = await renderSession(file);
    const text = transcripts[0]!.text;
    expect(text).toContain('(hook lr: {"x":1})');
    expect(text).toContain('(message sent while the agent worked: {"complex":true})');
    expect(text).toContain('USER (human): From a list');
    expect(text).toContain('← REFUSED (user-rejected) No!');
    expect(text).toContain('(system compact_boundary: )');
    expect(text).toContain('- [] USER (human): No uuid nor time');
  });

  it('groups failing commands without their setup steps', () => {
    expect(normCommand('cd /a && cd b; FOO=1 && export X=2 && nvm use --silent && npm run test -- x')).toBe(
      'npm run test',
    );
    expect(normCommand('. ./env.sh && make build')).toBe('make build');
    expect(normCommand(undefined)).toBe('');
  });

  it('masks secrets', () => {
    expect(mask('key sk-ant-abcdefghijklmnopqrst and ghp_abcdefghijklmnopqrstuvwx, password: hunter2')).toBe(
      'key [secret] and [secret], [secret]',
    );
  });
});

describe('the conversations of a session, as the report reads them', () => {
  it('shows one step per line, with its line number and uuid, secrets masked', async () => {
    const { transcripts, uuids } = await renderSession(await richSession());
    expect(transcripts.map((t) => [t.agent, t.name])).toEqual([
      ['main', 'conversation-main.txt'],
      ['a1', 'conversation-agent-a1.txt'],
      ['w1', 'conversation-agent-w1.txt'],
    ]);
    const main = transcripts[0]!.text;
    expect(main).toContain('L4 u4 [10:04:00] USER (human): Fix the dates, [secret]');
    expect(main).toContain('L6 u6 [10:06:00]   ← ERROR: FAIL');
    expect(main).toContain('AGENT → Bash: cd /w && source');
    expect(main).toContain('(file changed outside the agent: /w/other.ts)');
    expect(main).not.toContain('abcd1234secret');
    expect(uuids.has('u4')).toBe(true);
    expect(uuids.has('x1') || [...uuids].length > 28).toBe(true);
  });
});

/** A fake Claude Code that answers a report (and records what it was given). */
function fakeReporter(answer: (cwdFiles: string[]) => unknown, extra: Record<string, unknown> = {}) {
  const calls: { args: readonly string[]; cwd: string; files: string[]; analytics: string }[] = [];
  const runner: Runner = async (_cmd, args, { cwd }) => {
    const files = (await readdir(cwd)).sort();
    calls.push({ args, cwd, files, analytics: await readFile(join(cwd, 'analytics.json'), 'utf8') });
    const result = answer(files);
    return {
      stdout: JSON.stringify({
        is_error: false,
        result: typeof result === 'string' ? result : JSON.stringify(result),
        total_cost_usd: 0.4,
        duration_ms: 90_000,
        usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 70 },
        ...extra,
      }),
      stderr: '',
      code: 0,
      timedOut: false,
    };
  };
  return { runner, calls };
}

const goodAnswer = {
  summary: 'The user fixed the dates. api_key=sk-abcdefghijklmnopqrstu',
  outcome: 'achieved',
  signals: {
    collaboration: {
      corrections: {
        occurrences: 1,
        relevant: [
          { agent: 'main', uuid: 'u13', verdict: 'Corrected' },
          { agent: 'main', uuid: 'u-invented', verdict: 'Invented' },
        ],
      },
    },
  },
  patterns: [{ name: 'UTC', evidence: ['u13', 'u-nope'] }],
};

describe('a report on one session', () => {
  it('runs a separate Claude Code, read-only, on the session prepared in a temporary folder', async () => {
    const file = await richSession();
    const analytics = await analyseSession(file);
    const { runner, calls } = fakeReporter(() => '```json\n' + JSON.stringify(goodAnswer) + '\n```');
    const out = await writeReport(
      { transcript: { id: 's-rich', file, cwd: root, start: at(20) }, analytics, action: 'write' },
      env(),
      runner,
    );
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.args).toEqual(reportArgs(call.args[1]!));
    expect(call.args).toEqual(
      expect.arrayContaining(['--safe-mode', '--no-session-persistence', '--tools', 'Read,Grep']),
    );
    expect(call.args[call.args.indexOf('--model') + 1]).toBe('opus');
    expect(call.args[1]).toContain('The session: s-rich, with 2 sub-agent(s)');
    expect(call.files).toEqual([
      'analytics.json',
      'conversation-agent-a1.txt',
      'conversation-agent-w1.txt',
      'conversation-main.txt',
    ]);
    expect(JSON.parse(call.analytics).session_id).toBe('s-rich');
    // The temporary folder is gone.
    await expect(access(call.cwd)).rejects.toThrow();

    expect(out.kind).toBe('done');
    const r = (out as { report: SessionReport }).report;
    expect(r).toMatchObject({
      v: 1,
      session: 's-rich',
      agent: 'Claude Code',
      folder: root,
      covered: { lines: analytics.counts.lines },
      model: 'opus',
      run: { costUsd: 0.4, durationMs: 90_000, tokens: 100 },
      checks: { citedMoments: 3, unknownMoments: ['u-invented', 'u-nope'] },
    });
    // The moments that do not exist are removed; secrets quoted by the model are masked.
    expect(JSON.stringify(r.analysis)).not.toContain('u-invented');
    expect(JSON.stringify(r.analysis)).not.toContain('u-nope');
    expect(r.analysis.summary).toBe('The user fixed the dates. [secret]');
    expect(r.analysis.session_id).toBe('s-rich');
    expect(r.analytics.session_id).toBe('s-rich');
  });

  it('fails without a report when the model answers something else', async () => {
    const file = await richSession();
    const analytics = await analyseSession(file);
    const c = { transcript: { id: 's-rich', file, cwd: root, start: at(20) }, analytics, action: 'write' as const };
    expect(await writeReport(c, env(), fakeReporter(() => 'Sorry, I cannot.').runner)).toMatchObject({
      kind: 'failed',
      reason: 'the model did not answer with a report',
      costUsd: 0.4,
    });
    expect(await writeReport(c, env(), fakeReporter(() => 'Not logged in', { is_error: true }).runner)).toMatchObject({
      kind: 'failed',
      reason: 'Not logged in',
    });
    const crash: Runner = async () => ({ stdout: '', stderr: 'boom', code: 2, timedOut: false });
    expect(await writeReport(c, env(), crash)).toMatchObject({
      kind: 'failed',
      reason: 'Claude Code ended with code 2: boom',
    });
    const slow: Runner = async () => ({ stdout: '', stderr: '', code: null, timedOut: true });
    expect(await writeReport(c, env(), slow, 60_000)).toMatchObject({
      kind: 'failed',
      reason: 'it took more than 1 min',
    });
  });

  it('reads the JSON of an answer, with or without text around it', () => {
    expect(jsonOfAnswer('{"a":1}')).toEqual({ a: 1 });
    expect(jsonOfAnswer('Here it is:\n{"a":{"b":2}}\nDone.')).toEqual({ a: { b: 2 } });
    expect(jsonOfAnswer('[1]')).toBeNull();
    expect(jsonOfAnswer('nothing')).toBeNull();
    expect(
      dropUnknownMoments({ evidence: ['a', 'b', 3], list: [{ uuid: 'a' }, { uuid: 'b' }, 'x'] }, new Set(['a'])),
    ).toEqual({ evidence: ['a', 3], list: [{ uuid: 'a' }, 'x'] });
  });
});

describe('the reports of a retro', () => {
  const transcriptOf = (id: string, file: string, day = 20) => ({ id, file, cwd: root, start: at(day) });

  it('leaves out the sessions without a prompt typed and the retro session, and keeps reports up to date', async () => {
    const book = new RetroBook(root);
    clock = 0;
    const silent = await session('s-silent', [prompt('<command-name>/insights</command-name>')]);
    const retroSession = await session('s-retro', [
      prompt('Start'),
      line('assistant', { message: { content: 'rt_X' } }),
    ]);
    const mine = await session('s-mine', [prompt('Hello')]);
    const fresh = await session('s-fresh', [prompt('Fix it')]);
    const grown = await session('s-grown', [prompt('Fix it'), prompt('And this')]);
    const kept = await session('s-kept', [prompt('Fix it')]);
    const old = (id: string, lines: number): SessionReport => ({
      v: 1,
      session: id,
      agent: 'Claude Code',
      folder: root,
      start: at(20),
      end: at(20),
      covered: { lines },
      generatedAt: at(21),
      model: 'opus',
      run: { costUsd: 0.5, durationMs: 60_000, tokens: 1 },
      checks: { citedMoments: 0, unknownMoments: [] },
      analysis: { summary: 'Old' },
      analytics: { counts: { typed_prompts: 1 } },
    });
    await writeSessionReport(book, old('s-grown', 1));
    await writeSessionReport(book, old('s-kept', 1));
    const plan = await planReports(
      book,
      [
        transcriptOf('s-silent', silent),
        transcriptOf('s-retro', retroSession),
        transcriptOf('s-mine', mine),
        transcriptOf('s-fresh', fresh),
        transcriptOf('s-grown', grown),
        transcriptOf('s-kept', kept),
      ],
      { retroId: 'rt_X', exclude: new Set(['s-mine']) },
    );
    expect(plan.noPrompt).toBe(1);
    expect(plan.current).toBe(2);
    expect(plan.candidates.map((c) => [c.transcript.id, c.action])).toEqual([
      ['s-fresh', 'write'],
      ['s-grown', 'write'],
      ['s-kept', 'keep'],
    ]);

    // Written several at once; a session whose new report fails keeps its older one.
    let n = 0;
    const runner: Runner = async (...args) => {
      if (++n === 2) return { stdout: '', stderr: 'boom', code: 1, timedOut: false };
      return fakeReporter(() => ({ summary: 'New', signals: {} })).runner(...args);
    };
    const done = await writeReports(book, plan, env(), runner, 1);
    expect(done.refs).toEqual([
      { id: 's-fresh', start: at(20), status: 'analysed' },
      {
        id: 's-grown',
        start: at(20),
        status: 'reused',
        reason: 'not brought up to date: Claude Code ended with code 1: boom',
      },
      { id: 's-kept', start: at(20), status: 'reused' },
    ]);
    expect(done.costUsd).toBe(0.4);
    expect(done.tokens).toBe(100);
    expect((await readSessionReport(book, 's-fresh'))?.analysis.summary).toBe('New');
    expect((await readSessionReport(book, 's-grown'))?.analysis.summary).toBe('Old');
  });

  it('estimates the cost from the sizes of the sessions, scaled by the reports already written', async () => {
    const book = new RetroBook(root);
    const base0 = REPORT_COST.baseUsd + REPORT_COST.perPromptUsd * 10;
    expect((await estimateReports(book, [10])).costUsd).toBeCloseTo(base0);
    expect((await estimateReports(book, [])).ms).toBe(0);
    // Five sessions, four at once: the time of the longest worker.
    const ms = REPORT_COST.baseMs;
    expect((await estimateReports(book, [0, 0, 0, 0, 0])).ms).toBe(2 * ms);
    // The reports of this project cost twice the defaults: the estimate follows.
    await writeSessionReport(book, {
      v: 1,
      session: 's1',
      agent: 'Claude Code',
      folder: root,
      start: at(20),
      end: at(20),
      covered: { lines: 1 },
      generatedAt: at(21),
      model: 'opus',
      run: { costUsd: 2 * base0, durationMs: null, tokens: null },
      checks: { citedMoments: 0, unknownMoments: [] },
      analysis: {},
      analytics: { counts: { typed_prompts: 10 } },
    });
    expect((await estimateReports(book, [10])).costUsd).toBeCloseTo(2 * base0);
  });
});

describe('lr-retro sessions and lr-retro reports', () => {
  async function run(args: string[], runner?: Runner, own?: string) {
    let out = '';
    let err = '';
    const code = await runRetroCli(args, {
      cwd: base,
      env: env(),
      out: (t) => (out += t + '\n'),
      err: (t) => (err += t + '\n'),
      ...(runner ? { run: runner } : {}),
      session: async () => own,
    });
    return { code, out, err };
  }

  it('announces the reports to write with an estimate, then writes them for the retro', async () => {
    clock = 0;
    await session('s1', [prompt('Fix the dates'), prompt('Again')]);
    await session('s2', [prompt('<command-name>/insights</command-name>')]);
    await session('s-own', [prompt('/local-review:retro please')]);
    const scope = await run(['sessions', '--root', root, '--since', '2026-09-10'], undefined, 's-own');
    expect(scope.err).toBe('');
    expect(scope.out).toMatch(
      /^3 Claude Code sessions in this project since 2026-09-10\.\nReports on them: 1 to write \(about 1 min with 4 at once, and about \$0\.13 at the API list price: on a subscription, tokens counted against the usage limits, not a bill\), 0 already written, 1 without any prompt typed by the user \(not analysed\), and this session \(not analysed\)\.\nThe retro reads them through these reports \(setting retro-sessions: reports; Claude Code's \/insights is cheaper: lr config set retro-sessions insights\)\.\n$/,
    );

    const book = new RetroBook(root);
    const r = await book.start({ root, since: at(10), until: at(30), stores: [], threads: [], bytes: 0 });
    const { runner } = fakeReporter(() => ({ summary: 'Fixed', signals: {} }));
    const done = await run(['reports', r.id, '--root', root], runner, 's-own');
    expect(done).toMatchObject({ code: 0, err: '' });
    expect(done.out).toBe(
      'Reports on the 1 Claude Code session of this project in the period: 1 written, 0 kept from before, in 1 min ' +
        '(about $0.40 at the API list price). lr retro input --for analysis includes them.\n',
    );
    expect((await book.get(r.id)).reports).toMatchObject({
      source: 'Claude Code session records',
      list: [{ id: 's1', status: 'analysed' }],
      costUsd: 0.4,
      tokens: 100,
    });
    // Without a period asked for: the figures of every period to choose from.
    const periods = await run(['sessions', '--root', root], undefined, 's-own');
    expect(periods.out).toContain('Periods to choose from (as lr retro scope lists them):');
    expect(periods.out).toMatch(/- last 7 days \(--since 7d, proposed\): \d+ sessions?, \d+ reports? to write/);
    expect(periods.out).toContain('- whole history (--all): 3 sessions, 0 reports to write, 1 already written');

    // Read through /insights instead: no report to write, and the retro's own session left out.
    await writeConfig({ retroSessions: 'insights' }, env());
    const insights = await run(['sessions', '--root', root, '--since', '2026-09-10'], undefined, 's-own');
    expect(insights.out).toBe(
      '2 Claude Code sessions in this project since 2026-09-10 (this session left out).\n' +
        "The retro reads them through Claude Code's /insights (setting retro-sessions: insights; a report on each session is finer: lr config set retro-sessions reports). No report is written.\n",
    );
    const insightsPeriods = await run(['sessions', '--root', root], undefined, 's-own');
    expect(insightsPeriods.out).toContain('- whole history (--all): 2 sessions, read by /insights (about a minute)');
    await writeConfig({ retroSessions: 'reports' }, env());
    // A retro started in one mode never reads the sessions the other way.
    const other = await book.start({
      root,
      since: at(10),
      until: at(30),
      stores: [],
      threads: [],
      bytes: 0,
      sessionsMode: 'insights',
    });
    expect((await run(['reports', other.id, '--root', root], runner, 's-own')).out).toBe(
      "Skipped: this retro reads the sessions through Claude Code's /insights (setting retro-sessions when it started), never both.\n",
    );
    const byReports = await book.start({
      root,
      since: at(10),
      until: at(30),
      stores: [],
      threads: [],
      bytes: 0,
      sessionsMode: 'reports',
    });
    expect((await run(['insights', byReports.id, '--root', root], runner, 's-own')).out).toBe(
      'Skipped: this retro reads the sessions through a report on each one (setting retro-sessions when it started), never both.\n',
    );

    // Run again in the same retro: written for it all the same, and what it took is kept.
    const again = await run(['reports', r.id, '--root', root], runner, 's-own');
    expect(again.out).toContain('0 written, 1 kept from before.');
    expect((await book.get(r.id)).reports).toMatchObject({ list: [{ id: 's1', status: 'analysed' }], costUsd: 0.4 });
    // The next retro reuses it, at no cost.
    const next = await book.start({ root, since: at(10), until: at(30), stores: [], threads: [], bytes: 0 });
    await run(['reports', next.id, '--root', root], runner, 's-own');
    expect((await book.get(next.id)).reports).toMatchObject({ list: [{ id: 's1', status: 'reused' }], costUsd: null });
    expect((await run(['sessions', '--root', root, '--since', '2026-09-10'], undefined, 's-own')).out).toContain(
      'Reports on them: 0 to write, 1 already written',
    );
  });

  it('says which reports could not be written', async () => {
    clock = 0;
    await session('s1', [prompt('Fix the dates')]);
    const book = new RetroBook(root);
    const r = await book.start({ root, since: at(10), until: at(30), stores: [], threads: [], bytes: 0 });
    const crash: Runner = async () => ({ stdout: '', stderr: 'Not logged in', code: 1, timedOut: false });
    const failed = await run(['reports', r.id, '--root', root], crash);
    expect(failed.code).toBe(1);
    expect(failed.out).toContain('0 written, 0 kept from before, 1 could not be written');
    expect(failed.out).toContain('- s1: Claude Code ended with code 1: Not logged in');
  });
});

describe('the reports, in edge cases', () => {
  const report = (id: string, over: Partial<SessionReport> = {}): SessionReport => ({
    v: 1,
    session: id,
    agent: 'Claude Code',
    folder: root,
    start: at(20),
    end: at(20),
    covered: { lines: 1 },
    generatedAt: at(21),
    model: 'opus',
    run: { costUsd: null, durationMs: null, tokens: null },
    checks: { citedMoments: 0, unknownMoments: [] },
    analysis: { summary: 'Old' },
    analytics: {},
    ...over,
  });

  it('reads sparse records: missing fields, odd values, an empty session', async () => {
    clock = 0;
    const file = await session(
      's-sparse',
      [
        { type: 'system', subtype: 'local_command' },
        { type: 'system', subtype: 'stop_hook_summary' },
        { type: 'attachment', attachment: { type: 'skill_listing', names: ['ok', 3] } },
        { type: 'attachment', attachment: { type: 'nested_memory', path: '/w/n.md', content: 'text' } },
        { type: 'attachment', attachment: { type: 'hook_success' } },
        {
          type: 'assistant',
          message: { usage: 'none', content: [{ type: 'tool_use' }, { type: 'tool_use', name: 'Bash' }] },
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: 'q', name: 'AskUserQuestion', input: [] }] },
        },
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 's', name: 'Skill', input: {} }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', content: 'x', is_error: true }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'q' }] }, toolUseResult: { a: 1 } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 's' }] }, toolUseResult: 'text' },
        { type: 'user', toolUseResult: { gitOperation: 'push' }, message: { content: 'Push it' } },
        { type: 'pr-link', prNumber: 3 },
      ],
      { 'agent-bad': { meta: [1, 2], lines: [] } },
    );
    const a = await analyseSession(file);
    expect(a.agents[1]).toMatchObject({ id: 'bad', type: null, description: null, launchedBy: null });
    expect(a.setup.skills_available).toEqual(['ok']);
    expect(a.signals.collaboration?.agent_questions?.map((o) => [o.questions ?? null, o.tool_use_id])).toEqual([
      [[], 'q'],
      [null, 'q'],
    ]);
    expect(a.signals.setup?.skills?.[0]).toMatchObject({ kind: 'called_by_agent', skill: null });
    expect(a.signals.tools?.hooks).toEqual([
      expect.objectContaining({ kind: 'stop', hook_count: null, errors: 0 }),
      expect.objectContaining({ kind: 'output', hook: null, output: '' }),
    ]);
    expect(a.signals.tools?.tool_errors?.[0]).toMatchObject({ tool: '?', uuid: null, time: null });
    expect(a.counts.typed_prompts).toBe(1);
    expect(a.cwd).toBeNull();

    const empty = await analyseSession(await session('s-empty', []));
    expect(empty).toMatchObject({ cwd: null, start: null, end: null, title: null, custom_title: null });
    expect(empty.counts).toMatchObject({ typed_prompts: 0, lines: 0 });
  });

  it('knows the retro session from the registered session of its parent processes', async () => {
    expect(await currentSession(env())).toBeUndefined();
    await writeFile(join(base, 'not-a-folder'), '');
    expect(await currentSession({ ...env(), LOCAL_REVIEW_HOME: join(base, 'not-a-folder') })).toBeUndefined();
  });

  it('skips a session deleted meanwhile, and survives a Claude Code that crashes', async () => {
    const book = new RetroBook(root);
    clock = 0;
    const file = await session('s1', [prompt('Fix it')]);
    const plan = await planReports(
      book,
      [
        { id: 's-gone', file: join(projects, 's-gone.jsonl'), cwd: root, start: at(20) },
        { id: 's1', file, cwd: root, start: at(20) },
      ],
      { retroId: 'rt_Y' },
    );
    expect(plan.candidates.map((c) => c.transcript.id)).toEqual(['s1']);
    const crash: Runner = async () => {
      throw new Error('spawn claude ENOENT');
    };
    const done = await writeReports(book, plan, env(), crash);
    expect(done.refs).toEqual([{ id: 's1', start: at(20), status: 'failed', reason: 'spawn claude ENOENT' }]);
    expect(done.costUsd).toBeNull();
    const thrown: Runner = async () => {
      throw 'odd';
    };
    expect((await writeReports(book, plan, env(), thrown)).refs[0]).toMatchObject({ reason: 'odd' });
  });

  it('writes a report from an answer without cost, time or usage, and from bare analytics', async () => {
    clock = 0;
    const file = await session('s1', [prompt('Fix it')]);
    const analytics = await analyseSession(file);
    const bare = { ...analytics, cwd: null, start: null, end: null };
    const plain: Runner = async () => ({
      stdout: JSON.stringify({ result: JSON.stringify({ summary: 'Done', signals: {} }) }),
      stderr: '',
      code: 0,
      timedOut: false,
    });
    const out = await writeReport(
      { transcript: { id: 's1', file, cwd: '/x', start: at(3) }, analytics: bare, action: 'write' },
      env(),
      plain,
    );
    expect(out).toMatchObject({
      kind: 'done',
      report: { folder: '/x', start: at(3), end: at(3), run: { costUsd: null, durationMs: null, tokens: null } },
    });
    const error: Runner = async () => ({
      stdout: JSON.stringify({ is_error: true }),
      stderr: '',
      code: 1,
      timedOut: false,
    });
    expect(
      await writeReport(
        { transcript: { id: 's1', file, cwd: '/x', start: at(3) }, analytics, action: 'write' },
        env(),
        error,
      ),
    ).toMatchObject({ kind: 'failed', reason: 'an error' });
    const silent: Runner = async () => ({ stdout: '', stderr: '', code: null, timedOut: false });
    expect(
      await writeReport(
        { transcript: { id: 's1', file, cwd: '/x', start: at(3) }, analytics, action: 'write' },
        env(),
        silent,
      ),
    ).toMatchObject({ kind: 'failed', reason: 'Claude Code ended with code ?' });
    const zero: Runner = async () => ({
      stdout: JSON.stringify({ result: '{"summary":"x","signals":{}}', usage: { input_tokens: 0 } }),
      stderr: '',
      code: 0,
      timedOut: false,
    });
    expect(
      await writeReport(
        { transcript: { id: 's1', file, cwd: '/x', start: at(3) }, analytics, action: 'write' },
        env(),
        zero,
      ),
    ).toMatchObject({ report: { run: { tokens: null } } });
  });

  it('keeps a newer report, and estimates without the reports it cannot read', async () => {
    const book = new RetroBook(root);
    clock = 0;
    const file = await session('s1', [prompt('Fix it'), prompt('More')]);
    await writeSessionReport(book, report('s1', { v: 99 }));
    const plan = await planReports(book, [{ id: 's1', file, cwd: root, start: at(20) }]);
    expect(plan.candidates[0]!.action).toBe('keep');
    await mkdir(join(root, '.local-review', 'retros', 'sessions'), { recursive: true });
    await writeFile(join(root, '.local-review', 'retros', 'sessions', 'junk.json'), 'nope');
    await writeSessionReport(book, report('s2', { run: { costUsd: 1, durationMs: 1000, tokens: 1 } }));
    const est = await estimateReports(book, [0]);
    expect(est.costUsd).toBeCloseTo(1); // scaled on the report s2 alone (no prompt count known: the base)
  });
});

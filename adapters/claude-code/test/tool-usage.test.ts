import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RetroBook } from '@local-review/core';
import { runRetroCli } from '../src/retroCli';
import { setupTools } from '../src/retroSetup';
import { keptDays, sessionUses, setupUsage } from '../src/toolUsage';

let base: string;
let home: string;
let root: string;
let claudeDir: string;
const env = () => ({ HOME: home, LOCAL_REVIEW_HOME: join(base, 'machine') });

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'lr-tool-usage-')));
  home = join(base, 'home');
  root = join(base, 'work');
  claudeDir = join(home, '.claude');
  await mkdir(root, { recursive: true });
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const write = async (path: string, text: string) => {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text);
};

let clock = 0;
const line = (type: string, cwd: string, fields: Record<string, unknown>) => ({
  type,
  uuid: `u${++clock}`,
  timestamp: `2026-09-20T10:${String(clock % 60).padStart(2, '0')}:00.000Z`,
  cwd,
  ...fields,
});
const typed = (cwd: string, name: string) =>
  line('user', cwd, { message: { role: 'user', content: `<command-name>/${name}</command-name>` } });
const call = (cwd: string, name: string, input: Record<string, unknown>) =>
  line('assistant', cwd, { message: { content: [{ type: 'tool_use', id: `x${clock}`, name, input }] } });

/** A conversation of Claude Code, in the folder of its project. */
async function session(id: string, cwd: string, lines: object[], sub: object[] = []) {
  const dir = join(claudeDir, 'projects', cwd.replace(/[/.]/g, '-'));
  await write(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  if (sub.length)
    await write(join(dir, id, 'subagents', 'agent-a1.jsonl'), sub.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

/** A setup: two skills, a command in a folder and a sub-agent in the project; a sub-agent of the user. */
async function setup() {
  await write(join(root, '.claude', 'skills', 'specs', 'SKILL.md'), '---\nname: specs\n---\nWrite specs.');
  await write(join(root, '.claude', 'skills', 'unused', 'SKILL.md'), '---\nname: unused\n---\nNever.');
  // Deeper down: part of the bundle skill, not a skill of its own.
  await write(join(root, '.claude', 'skills', 'unused', 'sub', 'SKILL.md'), 'Part of unused.');
  await write(join(root, '.claude', 'commands', 'db', 'migrate.md'), 'Migrate.');
  await write(join(root, '.claude', 'agents', 'rev.md'), '---\nname: reviewer\ndescription: x\n---\nReview.');
  await write(join(claudeDir, 'agents', 'helper.md'), 'No front matter.');
}

describe('the usage of the tools of the setup', () => {
  it('names the skills, commands and sub-agents as Claude Code does', async () => {
    await setup();
    const tools = await setupTools(root, [], home, claudeDir);
    expect(tools.map((t) => [t.kind, t.name, t.scope])).toEqual([
      ['skill', 'specs', 'project'],
      ['skill', 'unused', 'project'],
      ['command', 'db:migrate', 'project'],
      ['agent', 'reviewer', 'project'],
      ['agent', 'helper', 'user'],
    ]);
    expect(tools[0]!.path).toBe(join(root, '.claude', 'skills', 'specs'));
    expect(tools[2]!.path).toBe(join(root, '.claude', 'commands', 'db', 'migrate.md'));
  });

  it('counts what the user typed and what the agent called, sub-agents included', async () => {
    await session(
      's1',
      root,
      [
        typed(root, 'specs'),
        call(root, 'Skill', { skill: 'specs' }),
        line('user', root, {
          message: {
            role: 'user',
            content: [{ type: 'text', text: '<command-name>/clear</command-name>' }, { type: 'image' }],
          },
        }),
        line('user', root, { message: { role: 'user', content: 42 } }),
        line('assistant', root, { message: { content: [{ type: 'tool_use', name: 'Skill' }, { type: 'text' }] } }),
      ],
      [call(root, 'Agent', { subagent_type: 'reviewer' }), call(root, 'Skill', { skill: 'db:migrate' })],
    );
    const file = join(claudeDir, 'projects', root.replace(/[/.]/g, '-'), 's1.jsonl');
    await writeFile(file, '{"broken": "Skill"\n' + (await readFile(file, 'utf8')));
    const use = await sessionUses(file);
    expect(Object.fromEntries(use.typed)).toEqual({ specs: 1, clear: 1 });
    expect(Object.fromEntries(use.called)).toEqual({ specs: 1, 'db:migrate': 1 });
    expect(Object.fromEntries(use.agents)).toEqual({ reviewer: 1 });
    expect(use.last).not.toBeNull();
  });

  it("counts the project's tools on its sessions, the user's on every project, the retro's own session left out", async () => {
    await setup();
    const other = join(base, 'other');
    await session('s1', root, [typed(root, 'specs'), call(root, 'Agent', { subagent_type: 'reviewer' })]);
    await session('s2', root, [call(root, 'Skill', { skill: 'specs' })]);
    await session('s-other', other, [typed(other, 'unused'), call(other, 'Agent', { subagent_type: 'helper' })]);
    await session('s-retro', root, [typed(root, 'db:migrate')]);
    const tools = await setupTools(root, [], home, claudeDir);
    const usage = await setupUsage(tools, claudeDir, root, env(), new Set(['s-retro']));
    const by = Object.fromEntries(usage.tools.map((t) => [t.name, [t.byUser, t.byAgent, t.sessions]]));
    expect(by).toEqual({
      specs: [1, 1, 2],
      unused: [0, 0, 0], // used in another project only: a project's tool counts on its sessions
      'db:migrate': [0, 0, 0], // used in the retro's own session only
      reviewer: [0, 1, 1],
      helper: [0, 1, 1], // the user's: counted on every project
    });
    expect(usage.tools.find((t) => t.name === 'specs')!.lastUsed).not.toBeNull();
    expect(usage.windows).toEqual([
      expect.objectContaining({ scope: 'project', sessions: 2, keptDays: 30 }),
      expect.objectContaining({ scope: 'user', sessions: 3, keptDays: 30 }),
    ]);
  });

  it('knows how long Claude Code keeps its sessions', async () => {
    expect(await keptDays(claudeDir)).toBe(30);
    await write(join(claudeDir, 'settings.json'), '{"cleanupPeriodDays": 90}');
    expect(await keptDays(claudeDir)).toBe(90);
    await write(join(claudeDir, 'settings.json'), 'not json');
    expect(await keptDays(claudeDir)).toBe(30);
  });

  it('is recorded in the retro by lr-retro usage', async () => {
    await setup();
    await session('s1', root, [typed(root, 'specs')]);
    const book = new RetroBook(root);
    const r = await book.start({
      root,
      since: null,
      until: '2026-10-01T00:00:00.000Z',
      stores: [],
      threads: [],
      bytes: 0,
    });
    let out = '';
    const code = await runRetroCli(['usage', r.id, '--root', root], {
      cwd: base,
      env: env(),
      out: (t) => (out += t + '\n'),
      err: () => undefined,
      session: async () => undefined,
    });
    expect(code).toBe(0);
    expect(out).toContain('Usage of the 5 skills, commands and sub-agents of the setup');
    expect(out).toContain("(the project's: 1 session)");
    expect(out).toContain(': 4 never used. lr retro input --for audit includes it.');
    expect((await book.get(r.id)).usage?.tools).toHaveLength(5);
  });
});

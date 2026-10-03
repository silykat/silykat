import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAnchorContext, RetroBook, Store, type Anchor } from '@local-review/core';
import { AUDIT_MODEL, auditArgs, runProcess, type Runner } from '../src/retroAudit';
import { classifyWithJev, readJevKey, type JevDeps } from '../src/retroJev';
import { runRetroCli } from '../src/retroCli';
import { collectSetup, FILE_CAP, renderSetup } from '../src/retroSetup';

let base: string;
let home: string;
const KEY = 'jev-test-key-not-real-1234';

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'lr-retro-claude-')));
  home = join(base, 'home');
  await mkdir(home);
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function put(path: string, content: string) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
}

describe('the Claude Code setup of a project', () => {
  it('gathers the rules files, the .claude/ and .agents/ folders, and only the hooks of the settings', async () => {
    const root = join(home, 'work', 'project');
    const repo = join(root, 'api');
    await put(join(home, 'work', 'CLAUDE.md'), '# parent rules');
    await put(join(root, 'CLAUDE.md'), '# project rules');
    await put(join(repo, 'CLAUDE.md'), '# api rules');
    await put(join(repo, 'CLAUDE.local.md'), '# my api rules');
    await put(join(repo, '.claude', 'rules', 'style.md'), 'style rule');
    await put(
      join(repo, '.claude', 'skills', 'deploy', 'SKILL.md'),
      '---\nname: deploy\ndescription: Deploys\n---\nSteps',
    );
    await put(join(repo, '.claude', 'skills', 'deploy', 'notes.md'), 'not a skill file');
    await put(join(repo, '.claude', 'commands', 'ship.md'), 'ship it');
    await put(join(repo, '.claude', 'agents', 'reviewer.md'), 'review it');
    await put(
      join(repo, '.claude', 'settings.json'),
      JSON.stringify({ env: { TOKEN: 'secret' }, hooks: { Stop: [] } }),
    );
    await put(join(repo, '.claude', 'settings.local.json'), JSON.stringify({ permissions: {} }));
    await put(join(root, '.agents', 'skills', 'x.md'), 'agents file');
    await put(join(home, '.claude', 'CLAUDE.md'), '# my rules everywhere');
    await put(join(home, '.claude', 'settings.json'), 'not json');
    await symlink(join(base, 'gone'), join(repo, '.claude', 'commands', 'broken.md'));
    await put(
      join(home, '.claude', 'skills', 'big', 'SKILL.md'),
      '---\nname: big\ndescription: Huge\n---\n' + 'x'.repeat(5000),
    );

    const files = await collectSetup(root, [repo], home);
    const rel = files.map((f) => `${f.kind} ${f.scope} ${f.path.replace(home, '~')} ${f.shown}`);
    expect(rel).toEqual([
      'rules project ~/work/CLAUDE.md full',
      'rules project ~/work/project/CLAUDE.md full',
      'rules project ~/work/project/api/CLAUDE.md full',
      'rules project ~/work/project/api/CLAUDE.local.md full',
      'rules project ~/work/project/api/.claude/rules/style.md full',
      'hooks project ~/work/project/api/.claude/settings.json full',
      'other project ~/work/project/.agents/skills/x.md full',
      'skill project ~/work/project/api/.claude/skills/deploy/SKILL.md full',
      'command project ~/work/project/api/.claude/commands/ship.md full',
      'agent project ~/work/project/api/.claude/agents/reviewer.md full',
      'rules user ~/.claude/CLAUDE.md full',
      'skill user ~/.claude/skills/big/SKILL.md full',
    ]);
    const hooks = files.find((f) => f.kind === 'hooks')!;
    expect(hooks.content).toContain('"Stop"');
    expect(hooks.content).not.toContain('secret');

    // Over the budget, skills only show their header; a long rules file is cut.
    await put(join(root, 'CLAUDE.md'), 'r'.repeat(FILE_CAP + 10));
    const tight = await collectSetup(root, [repo], home, undefined, 100);
    expect(tight.find((f) => f.path.endsWith('big/SKILL.md'))).toMatchObject({ shown: 'header' });
    expect(tight.find((f) => f.path.endsWith('big/SKILL.md'))!.content).toContain('description: Huge');
    expect(tight.find((f) => f.path.endsWith('ship.md'))!.content).toContain('ship it');
    expect(tight.find((f) => f.path === join(root, 'CLAUDE.md'))).toMatchObject({ shown: 'truncated' });

    const text = renderSetup(root, home, tight);
    expect(text).toContain('## Rules files');
    expect(text).toContain('### CLAUDE.md (project, truncated');
    expect(text).toContain('### ~/.claude/CLAUDE.md (user,');
    expect(text).toContain('### ~/work/CLAUDE.md (project,');
    expect(text).toContain('### api/.claude/skills/deploy/SKILL.md (project,');
    expect(renderSetup('/elsewhere', home, [{ ...files[0]!, path: '/other/CLAUDE.md' }])).toContain(
      '### /other/CLAUDE.md',
    );
  });
});

describe('the Jev key', () => {
  const keyFile = () => join(home, '.config', 'local-review', 'jev-key');

  it('is read only from the environment or a safe file', async () => {
    const env = { HOME: home };
    expect(await readJevKey({ ...env, JEV_API_KEY: ' k ' })).toBe('k');
    await expect(readJevKey(env)).rejects.toThrow('no Jev key');
    await put(keyFile(), `${KEY}\n`);
    await chmod(keyFile(), 0o640);
    await expect(readJevKey(env)).rejects.toThrow('not safe, fix it first: chmod 600');
    await chmod(keyFile(), 0o600);
    expect(await readJevKey(env)).toBe(KEY);
    await writeFile(keyFile(), '\n');
    await expect(readJevKey(env)).rejects.toThrow('is empty');
  });
});

type Reply = { status?: number; body?: unknown; fail?: boolean };

/** A stand-in for Jev: answers each request with the next reply, and records what it got. */
function stubFetch(
  replies: (req: { auth: string; body: { state: string; questions: Record<string, unknown> } }) => Reply,
) {
  const seen: { auth: string; body: { state: string; questions: Record<string, unknown> } }[] = [];
  const f: JevDeps['fetch'] = async (_url, init) => {
    const req = { auth: init.headers.Authorization!, body: JSON.parse(init.body) as never };
    seen.push(req);
    const r = replies(req);
    if (r.fail) throw new Error(`connection refused, with ${init.headers.Authorization}`);
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body };
  };
  return { f, seen };
}

const answer = (category: string, missing = 0.2, ignored = 0.7) => ({
  answers: {
    category: { choice: category, confidence: 0.9 },
    missing_rule: { noul: missing },
    ignored_rule: { noul: ignored },
  },
  usage: { cost_usd: 0.001 },
});

describe('classification by Jev', () => {
  it('labels each thread with its category and the two detectors', async () => {
    const { f, seen } = stubFetch((req) => ({ body: answer(req.body.state.includes('one') ? '3' : '2') }));
    const r = await classifyWithJev(
      [
        { id: 't_1', text: 'thread one' },
        { id: 't_2', text: 'thread two' },
      ],
      '# rules',
      { fetch: f, key: KEY, concurrency: 2 },
    );
    expect(r.labels).toEqual({
      t_1: { category: 3, confidence: 0.9, missingRule: 0.2, ignoredRule: 0.7 },
      t_2: { category: 2, confidence: 0.9, missingRule: 0.2, ignoredRule: 0.7 },
    });
    expect(r.costUsd).toBeCloseTo(0.002);
    expect(seen[0]!.auth).toBe(`Bearer ${KEY}`);
    expect(seen[0]!.body.state).toContain('# rules');
    expect(Object.keys(seen[0]!.body.questions)).toEqual(['category', 'missing_rule', 'ignored_rule']);
  });

  it('retries once, and never repeats a message that could hold the key', async () => {
    let calls = 0;
    const { f } = stubFetch(() => {
      calls++;
      if (calls === 1) return { status: 500 };
      if (calls === 2) return { body: answer('7') };
      if (calls <= 4) return { fail: true };
      return { body: { answers: { category: { choice: '99' } } } };
    });
    const r = await classifyWithJev(
      [
        { id: 't_1', text: 'a' },
        { id: 't_2', text: 'b' },
        { id: 't_3', text: 'c' },
      ],
      '',
      { fetch: f, key: KEY, concurrency: 1 },
    );
    expect(Object.keys(r.labels)).toEqual(['t_1']);
    expect(r.labels.t_1).toEqual({ category: 7, confidence: 0.9, missingRule: 0.2, ignoredRule: 0.7 });
    expect(r.failed).toEqual([
      { thread: 't_2', error: 'request failed (Error)' },
      { thread: 't_3', error: 'Jev gave no category' },
    ]);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });
});

const CODE = 'const a = 1;\nconst b = 2;\n';
const anchor = (): Anchor => ({
  path: 'src/a.ts',
  source: 'worktree',
  ref: null,
  sha: null,
  ...buildAnchorContext(CODE, { startLine: 1, endLine: 1 }),
});

describe('lr-retro', () => {
  async function retro() {
    const root = join(base, 'work');
    const store = new Store(join(root, 'api'));
    const t1 = await store.createThread(anchor(), { author: 'user', body: 'Use cents', reviewId: null });
    const t2 = await store.createThread(anchor(), { author: 'user', body: 'Cents again', reviewId: null });
    await put(join(root, 'api', 'CLAUDE.md'), '- Amounts are integers in cents.');
    const book = new RetroBook(root);
    const r = await book.start({
      root,
      since: null,
      until: new Date().toISOString(),
      stores: [{ root: join(root, 'api'), origin: 'below', threads: 2, bytes: 1 }],
      threads: [t1.id, t2.id],
      bytes: 1,
    });
    return { root, book, id: r.id, t1: t1.id, t2: t2.id };
  }

  async function run(args: string[], env: Record<string, string>, fetchImpl?: JevDeps['fetch'], runner?: Runner) {
    let out = '';
    let err = '';
    const code = await runRetroCli(args, {
      cwd: base,
      env: { HOME: home, LOCAL_REVIEW_HOME: join(base, 'machine'), ...env },
      out: (t) => (out += t + '\n'),
      err: (t) => (err += t + '\n'),
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
      ...(runner ? { run: runner } : {}),
    });
    return { code, out, err };
  }

  it('writes the setup of the project in a file of the retro', async () => {
    const { root, id } = await retro();
    await put(join(base, 'claude-config', 'CLAUDE.md'), '# from CLAUDE_CONFIG_DIR');
    const r = await run(['setup', id, '--root', root], { CLAUDE_CONFIG_DIR: join(base, 'claude-config') });
    expect(r.code).toBe(0);
    const file = join(root, '.local-review', 'retros', id, 'setup.md');
    expect(r.out).toContain(`Written: ${file}`);
    expect(r.out).toContain('2 setup files (2 rules files).');
    expect(await readFile(file, 'utf8')).toContain('Amounts are integers in cents');
    expect(await readFile(file, 'utf8')).toContain('# from CLAUDE_CONFIG_DIR');
  });

  it('classifies with Jev through HTTP, and records the labels without ever showing the key', async () => {
    const { root, book, id, t1, t2 } = await retro();
    const requests: { auth: string; body: string }[] = [];
    const server = createServer((req: IncomingMessage, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        requests.push({ auth: req.headers.authorization ?? '', body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer('2')));
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/decide`;
    try {
      const r = await run(['jev', id, '--root', root], { JEV_API_KEY: KEY, LR_JEV_URL: url });
      expect(r).toMatchObject({ code: 0, err: '' });
      expect(r.out).toContain('Classified 2/2 threads with Jev');
      expect(r.out + r.err).not.toContain(KEY);
      expect(requests).toHaveLength(2);
      expect(requests.every((q) => q.auth === `Bearer ${KEY}` && !q.body.includes(KEY))).toBe(true);
      expect(requests[0]!.body).toContain('Amounts are integers in cents');
      const labels = (await book.get(id)).classification!;
      expect(labels.by).toEqual(['jev']);
      expect(Object.keys(labels.labels).sort()).toEqual([t1, t2].sort());
    } finally {
      server.close();
    }
    const journal = await readFile(book.retroFile(id), 'utf8');
    expect(journal).not.toContain(KEY);
  });

  it('fails clearly without a key, or when Jev answers nothing', async () => {
    const { root, id } = await retro();
    const none = await run(['jev', id, '--root', root], {});
    expect(none).toMatchObject({ code: 1 });
    expect(none.err).toContain('no Jev key');
    const { f } = stubFetch(() => ({ status: 401 }));
    const denied = await run(['jev', id, '--root', root], { JEV_API_KEY: KEY }, f);
    expect(denied.code).toBe(1);
    expect(denied.out).toContain('Classified 0/2 threads with Jev.');
    expect(denied.out).toContain('Jev answered HTTP 401');
    expect(denied.out).not.toContain(KEY);
  });

  describe('the audit of the setup', () => {
    /** A fake Claude Code: its version, then the audit's JSON answer (or what `audit` returns). */
    const fakeClaude = (version: string, audit: Partial<Awaited<ReturnType<Runner>>>) => {
      const calls: { args: readonly string[]; cwd: string }[] = [];
      const runner: Runner = async (_cmd, args, { cwd }) => {
        calls.push({ args, cwd });
        if (args[0] === '--version') return { stdout: version, stderr: '', code: 0, timedOut: false };
        return { stdout: '', stderr: '', code: 0, timedOut: false, ...audit };
      };
      return { runner, calls };
    };

    it('runs /doctor prompt-audit read-only in the project, and writes its report in the retro', async () => {
      const { root, id } = await retro();
      const answer = {
        result: '## Findings\n- CLAUDE.md:2-3 contradicts itself',
        total_cost_usd: 0.42,
        duration_ms: 185_000,
      };
      const { runner, calls } = fakeClaude('2.1.288 (Claude Code)', { stdout: JSON.stringify(answer) });
      const r = await run(['audit', id, '--root', root], {}, undefined, runner);
      expect(r).toMatchObject({ code: 0, err: '' });
      const file = join(root, '.local-review', 'retros', id, 'audit.md');
      expect(r.out).toBe(`Written: ${file}\nThe audit of the setup is done in 3 min (about $0.42).\n`);
      const report = await readFile(file, 'utf8');
      expect(report).toContain('# Audit of the setup — /doctor prompt-audit');
      expect(report).toContain('CLAUDE.md:2-3 contradicts itself');
      expect(calls[1]).toEqual({ args: auditArgs(join(home, '.claude')), cwd: root });
      expect(calls[1]!.args.slice(0, 2)).toEqual(['-p', '/doctor prompt-audit']);
      expect(calls[1]!.args).toContain(AUDIT_MODEL);
      for (const tool of ['Bash', 'Edit', 'Write', 'NotebookEdit']) expect(calls[1]!.args).toContain(tool);
    });

    it('works from the first version that has it, even without its cost or duration', async () => {
      const { root, id } = await retro();
      const r = await run(
        ['audit', id, '--root', root],
        {},
        undefined,
        fakeClaude('2.1.283', { stdout: JSON.stringify({ result: 'Nothing stale.' }) }).runner,
      );
      expect(r.out).toContain('The audit of the setup is done.\n');
    });

    it('is skipped without a recent enough Claude Code, and fails clearly', async () => {
      const { root, id } = await retro();
      const old = await run(['audit', id, '--root', root], {}, undefined, fakeClaude('2.1.200', {}).runner);
      expect(old).toMatchObject({ code: 0 });
      expect(old.out).toContain(
        'Audit skipped: /doctor prompt-audit needs Claude Code 2.1.283 or later (here 2.1.200).',
      );
      const missing: Runner = async () => ({ stdout: '', stderr: 'not found', code: null, timedOut: false });
      expect((await run(['audit', id, '--root', root], {}, undefined, missing)).out).toContain(
        'Audit skipped: Claude Code was not found.',
      );
      const slow = await run(
        ['audit', id, '--root', root],
        {},
        undefined,
        fakeClaude('2.1.300', { timedOut: true }).runner,
      );
      expect(slow.code).toBe(1);
      expect(slow.err).toContain('the audit failed: it took more than 15 min');
      const broken = await run(
        ['audit', id, '--root', root],
        {},
        undefined,
        fakeClaude('3.0.0', { stdout: 'oops', stderr: 'boom\nlast words', code: 2 }).runner,
      );
      expect(broken.err).toContain('Claude Code ended with code 2: last words');
      const empty = await run(
        ['audit', id, '--root', root],
        {},
        undefined,
        fakeClaude('2.2.0', { stdout: JSON.stringify({ result: '', is_error: true }) }).runner,
      );
      expect(empty.err).toContain('the audit gave no report');
      const errored = await run(
        ['audit', id, '--root', root],
        {},
        undefined,
        fakeClaude('2.2.0', { stdout: JSON.stringify({ result: 'Not logged in\nmore', is_error: true }) }).runner,
      );
      expect(errored.err).toContain('the audit failed: Not logged in.');
    });

    it('starts a real process, and tells a timeout', async () => {
      const ok = await runProcess(process.execPath, ['-e', 'process.stdout.write("hi")'], {
        cwd: base,
        env: process.env,
        timeoutMs: 10_000,
      });
      expect(ok).toEqual({ stdout: 'hi', stderr: '', code: 0, timedOut: false });
      const failed = await runProcess(process.execPath, ['-e', 'process.exit(3)'], {
        cwd: base,
        env: process.env,
        timeoutMs: 10_000,
      });
      expect(failed).toMatchObject({ code: 3, timedOut: false });
      const slow = await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
        cwd: base,
        env: process.env,
        timeoutMs: 200,
      });
      expect(slow.timedOut).toBe(true);
      const absent = await runProcess(join(base, 'no-such-binary'), [], {
        cwd: base,
        env: process.env,
        timeoutMs: 1000,
      });
      expect(absent).toMatchObject({ code: null, timedOut: false });
    });
  });

  it('explains its usage', async () => {
    expect((await run([], {})).out).toContain('lr-retro setup <retro-id>');
    expect((await run([], {})).out).toContain('lr-retro audit <retro-id>');
    expect((await run(['what'], {})).code).toBe(1);
    expect((await run(['setup'], {})).err).toContain('missing <retro-id>');
    expect((await run(['setup', 'rt_00000000000000000000000000', '--root', base], {})).err).toContain(
      'Retro not found',
    );
  });
});

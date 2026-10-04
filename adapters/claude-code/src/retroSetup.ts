import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * Claude Code's setup that applies to a project, given as is to the retro's agents: the rules files
 * (`CLAUDE.md` of the folder, of its parents and repositories, `CLAUDE.local.md`, `~/.claude/CLAUDE.md`),
 * and the `.claude/` and `.agents/` folders of the project and of the home folder (skills, commands,
 * sub-agents, rules, and the hooks of the settings).
 */
export type SetupKind = 'rules' | 'skill' | 'command' | 'agent' | 'hooks' | 'other';

export interface SetupFile {
  path: string;
  kind: SetupKind;
  /** `project`: the project folder, its parents and repositories; `user`: the home folder. */
  scope: 'project' | 'user';
  bytes: number;
  /** Shown in full (or up to the per-file cap), or only its header when over the budget. */
  content: string;
  shown: 'full' | 'truncated' | 'header';
}

/** A file longer than this is cut. */
export const FILE_CAP = 24_000;
/** Past this total, skills, commands and agents only show their header (the agents can read them). */
export const SETUP_BUDGET = 100_000;

/** The value, or `null` when it failed (a file gone, a broken link…). */
const orNull = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);
const exists = async (p: string) => (await orNull(stat(p))) !== null;

/** Markdown files of a folder, a few levels deep (symbolic links followed). */
async function markdown(dir: string, depth = 3): Promise<string[]> {
  if (depth < 0) return [];
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: string[] = [];
  for (const name of names.sort()) {
    const p = join(dir, name);
    const st = await orNull(stat(p));
    if (!st) continue;
    if (st.isDirectory()) out.push(...(await markdown(p, depth - 1)));
    else if (name.endsWith('.md')) out.push(p);
  }
  return out;
}

/** `path` is strictly inside `dir` (whatever the platform's separator). */
const isInside = (path: string, dir: string) => {
  const rel = relative(dir, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/** The folders a project spans: its parents (up to the home folder), itself, its repositories. */
function projectDirs(root: string, repos: readonly string[], home: string): string[] {
  const parents: string[] = [];
  let dir = dirname(resolve(root));
  const top = resolve(home);
  while (dir !== dirname(dir) && isInside(dir, top)) {
    parents.unshift(dir);
    dir = dirname(dir);
  }
  return [...new Set([...parents, resolve(root), ...repos.map((r) => resolve(r))])];
}

interface Found {
  path: string;
  kind: SetupKind;
  scope: 'project' | 'user';
}

async function found(root: string, repos: readonly string[], home: string, claudeDir: string): Promise<Found[]> {
  const files: Found[] = [];
  const add = async (path: string, kind: SetupKind, scope: Found['scope']) => {
    if (!files.some((f) => f.path === path) && (await exists(path))) files.push({ path, kind, scope });
  };
  const dirs = projectDirs(root, repos, home);
  for (const d of dirs)
    for (const name of ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md'])
      await add(join(d, name), 'rules', 'project');
  await add(join(claudeDir, 'CLAUDE.md'), 'rules', 'user');
  /** The setup in a `.claude/` folder, and in the `.agents/` folder next to it. */
  const setupOf = async (claude: string, agents: string, scope: Found['scope']) => {
    for (const f of await markdown(join(claude, 'rules'))) await add(f, 'rules', scope);
    for (const f of await markdown(join(claude, 'skills'), 2))
      if (basename(f) === 'SKILL.md') await add(f, 'skill', scope);
    for (const f of await markdown(join(claude, 'commands'))) await add(f, 'command', scope);
    for (const f of await markdown(join(claude, 'agents'))) await add(f, 'agent', scope);
    for (const name of ['settings.json', 'settings.local.json']) await add(join(claude, name), 'hooks', scope);
    for (const f of await markdown(agents)) await add(f, 'other', scope);
  };
  for (const d of [resolve(root), ...repos.map((r) => resolve(r))])
    await setupOf(join(d, '.claude'), join(d, '.agents'), 'project');
  await setupOf(claudeDir, join(home, '.agents'), 'user');
  return files;
}

/** A skill, command or sub-agent of the setup, named as Claude Code names it. */
export interface SetupTool {
  kind: 'skill' | 'command' | 'agent';
  name: string;
  scope: 'project' | 'user';
  file: string;
  /** What goes with it: a skill's folder, else its file. */
  path: string;
}

/** The `name:` of a front matter, if any. */
const frontName = (text: string) => /^---\n[\s\S]*?^name:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(text)?.[1]?.trim();

/**
 * The skills, commands and sub-agents of a project's setup and of the user's: a skill is named after
 * its folder, a command after its path in `commands/` (`a/b.md` is `/a:b`), a sub-agent by the `name`
 * of its front matter, else its file.
 */
export async function setupTools(
  root: string,
  repos: readonly string[],
  home: string,
  claudeDir = join(home, '.claude'),
): Promise<SetupTool[]> {
  const out: SetupTool[] = [];
  for (const f of await found(root, repos, home, claudeDir)) {
    if (f.kind !== 'skill' && f.kind !== 'command' && f.kind !== 'agent') continue;
    const text = (await orNull(readFile(f.path, 'utf8'))) ?? '';
    if (f.kind === 'skill') {
      // Claude Code loads `skills/<name>/SKILL.md` only: a SKILL.md deeper down belongs to that skill.
      if (basename(dirname(dirname(f.path))) !== 'skills') continue;
      out.push({ ...f, kind: 'skill', name: basename(dirname(f.path)), file: f.path, path: dirname(f.path) });
    } else if (f.kind === 'command') {
      const dir = f.path.slice(0, f.path.lastIndexOf('/commands/') + '/commands/'.length);
      const name = f.path.slice(dir.length, -'.md'.length).split('/').join(':');
      out.push({ ...f, kind: 'command', name, file: f.path, path: f.path });
    } else
      out.push({ ...f, kind: 'agent', name: frontName(text) ?? basename(f.path, '.md'), file: f.path, path: f.path });
  }
  return out;
}

/** The front matter of a skill, command or agent: its name and description. */
function header(text: string): string {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  return m ? `---\n${m[1]}\n---\n(header only: read the file for the rest)` : text.split('\n').slice(0, 5).join('\n');
}

/** Only the hooks of a settings file: the rest may hold secrets (environment variables…). */
function hooksOf(text: string): string | null {
  try {
    const hooks = (JSON.parse(text) as { hooks?: unknown }).hooks;
    return hooks ? JSON.stringify({ hooks }, null, 2) : null;
  } catch {
    return null;
  }
}

export async function collectSetup(
  root: string,
  repos: readonly string[],
  home: string,
  claudeDir = join(home, '.claude'),
  budget = SETUP_BUDGET,
): Promise<SetupFile[]> {
  const out: SetupFile[] = [];
  let used = 0;
  // Rules and hooks first, always in full: they are what the retro improves most often.
  const all = await found(root, repos, home, claudeDir);
  const order = (f: Found) => (f.kind === 'rules' || f.kind === 'hooks' ? 0 : 1) + (f.scope === 'user' ? 2 : 0);
  for (const f of [...all].sort((a, b) => order(a) - order(b))) {
    const raw = await orNull(readFile(f.path, 'utf8'));
    if (raw === null) continue;
    let content = f.kind === 'hooks' ? hooksOf(raw) : raw;
    if (content === null) continue;
    let shown: SetupFile['shown'] = 'full';
    if (f.kind !== 'rules' && f.kind !== 'hooks' && used + Math.min(content.length, FILE_CAP) > budget) {
      content = header(content);
      shown = 'header';
    } else if (content.length > FILE_CAP) {
      content = content.slice(0, FILE_CAP) + '\n[… cut: read the file for the rest]';
      shown = 'truncated';
    }
    used += content.length;
    out.push({ ...f, bytes: Buffer.byteLength(raw), content, shown });
  }
  return out;
}

const TITLES: Record<SetupKind, string> = {
  rules: 'Rules files',
  hooks: 'Hooks (from the settings)',
  skill: 'Skills',
  command: 'Commands',
  agent: 'Sub-agents',
  other: 'Other agent files (.agents/)',
};

/** The setup, for the analysis step. Paths are relative to the project when inside it. */
export function renderSetup(root: string, home: string, files: readonly SetupFile[]): string {
  const label = (p: string) => {
    if (isInside(p, resolve(root))) return relative(root, p);
    if (isInside(p, resolve(home))) return '~/' + relative(home, p);
    return p;
  };
  const lines = [
    `# Claude Code setup — ${root}`,
    '',
    `${files.length} files. The project's files come first, then the user's (~). Paths relative to the project.`,
    'Targets: project-shared = a CLAUDE.md or .claude/ file committed in a repository; project-personal = CLAUDE.local.md',
    '(or the CLAUDE.md of a parent folder outside any repository); user = ~/.claude/CLAUDE.md, ~/.claude/.',
  ];
  for (const kind of Object.keys(TITLES) as SetupKind[]) {
    const fs = files.filter((f) => f.kind === kind);
    lines.push('', `## ${TITLES[kind]}`, '');
    if (fs.length === 0) lines.push('None.');
    for (const f of fs)
      lines.push(
        `### ${label(f.path)} (${f.scope}${f.shown === 'full' ? '' : `, ${f.shown}`}, ${f.bytes} bytes)`,
        '',
        '````',
        f.content.trimEnd(),
        '````',
        '',
      );
  }
  return lines.join('\n');
}

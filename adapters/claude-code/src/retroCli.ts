import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { RetroBook, retroHome, retroThreads, threadText, writeRetroFile } from '@local-review/core';
import { classifyWithJev, readJevKey, type JevDeps } from './retroJev';
import { collectSetup, renderSetup } from './retroSetup';

/** What is Claude Code's in a retro: its setup files, and the classification by Jev. */
export const RETRO_CLI_USAGE = `lr-retro — the Claude Code part of Local Review's retros

  lr-retro setup <retro-id> [--root <dir>]   Write Claude Code's setup of the project (rules files,
                                             .claude/ and .agents/ of the project and of ~) in a file
                                             of the retro, for its analysis
  lr-retro jev <retro-id> [--root <dir>]     Classify the retro's threads with Jev (needs a key:
                                             lr retro key), and record the labels`;

export interface RetroCliIo {
  cwd: string;
  env: Record<string, string | undefined>;
  out(text: string): void;
  err(text: string): void;
  fetch?: JevDeps['fetch'];
}

/** The rules files, as context for each Jev decision. */
const RULES_CAP = 8000;

export async function runRetroCli(args: string[], io: RetroCliIo): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args,
      options: { root: { type: 'string' } },
      allowPositionals: true,
    });
    const [action, id] = positionals;
    if (action !== 'setup' && action !== 'jev') {
      io.out(RETRO_CLI_USAGE);
      return action === undefined || action === 'help' ? 0 : 1;
    }
    if (!id) throw new Error('missing <retro-id>');
    const root = values.root ?? io.cwd;
    const book = new RetroBook(await retroHome(root, io.env));
    const retro = await book.get(id);
    const home = io.env.HOME?.trim() || homedir();
    // Claude Code keeps the user's setup in $CLAUDE_CONFIG_DIR when it is set, else in ~/.claude.
    const claudeDir = io.env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude');
    const repos = retro.stores.map((s) => s.root);
    if (action === 'setup') {
      const files = await collectSetup(retro.root, repos, home, claudeDir);
      const file = await writeRetroFile(book, retro.id, 'setup.md', renderSetup(retro.root, home, files));
      const header = files.filter((f) => f.shown === 'header').length;
      io.out(
        `Written: ${file}\n${files.length} setup files (${files.filter((f) => f.kind === 'rules').length} rules files)` +
          (header ? `, ${header} shown by their header only (over the size budget: read them if needed)` : '') +
          '.',
      );
      return 0;
    }
    const key = await readJevKey(io.env);
    const { threads } = await retroThreads(retro, io.env);
    const rules = (await collectSetup(retro.root, repos, home, claudeDir))
      .filter((f) => f.kind === 'rules')
      .map((f) => `## ${f.path}\n${f.content}`)
      .join('\n\n')
      .slice(0, RULES_CAP);
    const result = await classifyWithJev(
      [...threads.values()].map(({ thread, store }) => ({ id: thread.id, text: threadText(thread, store) })),
      rules,
      { fetch: io.fetch ?? (fetch as unknown as JevDeps['fetch']), key, url: io.env.LR_JEV_URL?.trim() || undefined },
    );
    const n = Object.keys(result.labels).length;
    if (n > 0) await book.record(retro.id, [{ type: 'retro.classified', by: 'jev', labels: result.labels }]);
    io.out(
      `Classified ${n}/${threads.size} threads with Jev` +
        (result.costUsd ? ` (about $${result.costUsd.toFixed(2)})` : '') +
        '.' +
        (result.failed.length
          ? `\n${result.failed.length} failed: ${result.failed.map((f) => `${f.thread} (${f.error})`).join(', ')}`
          : ''),
    );
    return n > 0 ? 0 : 1;
  } catch (err) {
    io.err(`lr-retro: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

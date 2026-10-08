import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  AUDIT_FILE,
  parseDateArg,
  readConfig,
  type RetroSource,
  type SessionsMode,
  readSessionReport,
  recordRetroSessions,
  RetroBook,
  retroHome,
  retroScope,
  retroThreads,
  threadText,
  writeRetroFile,
} from '@local-review/core';
import { AUDIT_COMMAND, runAudit, type Runner } from './retroAudit';
import { INSIGHTS_SOURCE, projectSessions, projectTranscripts, runInsights } from './retroInsights';
import {
  currentSession,
  estimateReports,
  planReports,
  REPORT_CONCURRENCY,
  REPORTS_SOURCE,
  writeReports,
} from './sessionReports';
import { classifyWithJev, readJevKey, type JevDeps } from './retroJev';
import { threadConversations } from './retroConversation';
import { collectSetup, renderSetup, setupTools } from './retroSetup';
import { setupUsage } from './toolUsage';

/** What is Claude Code's in a retro: its setup files, and the classification by Jev. */
export const RETRO_CLI_USAGE = `lr-retro — the Claude Code part of Local Review's retros

  lr-retro setup <retro-id> [--root <dir>]   Write Claude Code's setup of the project (rules files,
                                             .claude/ and .agents/ of the project and of ~) in a file
                                             of the retro, for its analysis
  lr-retro jev <retro-id> [--root <dir>]     Classify the retro's threads with Jev (needs a key:
                                             lr retro key), and record the labels
  lr-retro audit <retro-id> [--root <dir>]   Audit the setup with /doctor prompt-audit (a separate,
                                             read-only Claude Code; several minutes), in a file of
                                             the retro, for its analysis

  lr-retro sessions [--root <dir>] [--since <date> | --all]
                                             How many Claude Code sessions the project had in the
                                             period of the next retro (as lr retro scope), how many
                                             need a report, and what writing them would take
  lr-retro reports <retro-id> [--root <dir>]
                                             Write a report on each Claude Code session of the
                                             project and of the retro's period (one separate Claude
                                             Code each, with Opus, several at once), or reuse the
                                             one already written, for its analysis
  lr-retro insights <retro-id> [--root <dir>]
                                             Run Claude Code's /insights (a separate Claude Code,
                                             about a minute), then keep what it knows of the
                                             sessions of the project and of the retro's period, for
                                             its analysis

  lr-retro usage <retro-id> [--root <dir>]   Count how much each skill, command and sub-agent of the
                                             setup was used, from Claude Code's sessions (the
                                             project's tools on its sessions, the user's on every
                                             project), without a model, for the analysis of the audit

  lr-retro conversation <retro-id> <thread-id> [--root <dir>]
                                             Read back Claude Code's conversation where the agent
                                             replied in that thread (the steps that led to each
                                             reply), while Claude Code keeps it (30 days by
                                             default); the retro records it was read back`;

export interface RetroCliIo {
  cwd: string;
  env: Record<string, string | undefined>;
  out(text: string): void;
  err(text: string): void;
  fetch?: JevDeps['fetch'];
  /** Starts a process (the audit's Claude Code). */
  run?: Runner;
  /** The Claude Code session this command runs in, when known (the retro's own: not reported on). */
  session?: (env: Record<string, string | undefined>) => Promise<string | undefined>;
}

/** A date as people read it: its local day. */
const localDay = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** How the next retro reads the sessions, as `lr-retro sessions` says it. */
const MODE_LINE: Record<SessionsMode, string> = {
  reports:
    "The retro reads them through these reports (setting retro-sessions: reports; Claude Code's /insights is cheaper: lr config set retro-sessions insights).",
  insights:
    "The retro reads them through Claude Code's /insights (setting retro-sessions: insights; a report on each session is finer: lr config set retro-sessions reports).",
};

/** The source of a retro each action reads: skipped when the retro does not read it. */
const SOURCE_OF_ACTION: Partial<Record<string, RetroSource>> = {
  jev: 'reviews',
  audit: 'audit',
  usage: 'audit',
  reports: 'sessions',
  insights: 'sessions',
};

const SOURCE_WORDS: Record<RetroSource, string> = {
  reviews: 'the review threads',
  sessions: 'the Claude Code sessions',
  audit: 'the audit of the setup',
};

/** A duration, in minutes. */
const minutes = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))} min`;

/** The rules files, as context for each Jev decision. */
const RULES_CAP = 8000;

export async function runRetroCli(args: string[], io: RetroCliIo): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args,
      options: { root: { type: 'string' }, since: { type: 'string' }, all: { type: 'boolean' } },
      allowPositionals: true,
    });
    const [action, id, threadId] = positionals;
    const actions = ['setup', 'jev', 'audit', 'conversation', 'insights', 'sessions', 'reports', 'usage'];
    if (action === undefined || !actions.includes(action)) {
      io.out(RETRO_CLI_USAGE);
      return action === undefined || action === 'help' ? 0 : 1;
    }
    const root = values.root ?? io.cwd;
    const home = io.env.HOME?.trim() || homedir();
    // Claude Code keeps the user's setup in $CLAUDE_CONFIG_DIR when it is set, else in ~/.claude.
    const claudeDir = io.env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude');
    if (action === 'sessions') {
      if (values.since !== undefined && values.all) throw new Error('give --since or --all, not both');
      const since = values.since === undefined ? undefined : parseDateArg(values.since);
      if (since === null) throw new Error(`--since takes a date (2026-10-01) or a number of days ago (7d)`);
      const scope = await retroScope(root, { ...(since ? { since } : {}), all: values.all === true, env: io.env });
      const book = new RetroBook(await retroHome(scope.root, io.env));
      const own = await (io.session ?? currentSession)(io.env);
      /** The sessions of a period, and the reports they need. */
      const period = async (from: string | null) => {
        const transcripts = await projectTranscripts(
          claudeDir,
          scope.root,
          { since: from, until: scope.until },
          io.env,
        );
        const plan = await planReports(book, transcripts, own ? { exclude: new Set([own]) } : {});
        const writing = plan.candidates.filter((c) => c.action === 'write');
        const est = await estimateReports(
          book,
          writing.map((c) => c.analytics.counts.typed_prompts),
        );
        return {
          sessions: transcripts.length,
          plan,
          toWrite: writing.length,
          kept: plan.candidates.length - writing.length,
          est,
        };
      };
      const mode = (await readConfig(io.env)).retroSessions;
      if (mode === 'insights') {
        // The agent's own summaries: /insights reads the sessions in about a minute, no report is written.
        const count = async (from: string | null) =>
          (await projectTranscripts(claudeDir, scope.root, { since: from, until: scope.until }, io.env)).filter(
            (t) => t.id !== own,
          ).length;
        const n = await count(scope.since);
        const lines = [
          `${n} Claude Code session${n === 1 ? '' : 's'} in this project ` +
            (scope.since ? `since ${localDay(scope.since)}` : 'over the whole history') +
            (own ? ' (this session left out)' : '') +
            '.',
          `${MODE_LINE.insights} No report is written.`,
        ];
        if (scope.options.length > 0) {
          lines.push('', 'Periods to choose from (as lr retro scope lists them):');
          for (const o of scope.options) {
            const x = o.since === scope.since ? n : await count(o.since);
            lines.push(
              `- ${o.label} (${o.flag || 'the default'}${o.proposed ? ', proposed' : ''}): ${x} session${x === 1 ? '' : 's'}, read by /insights (about a minute)`,
            );
          }
        }
        io.out(lines.join('\n'));
        return 0;
      }
      const p = await period(scope.since);
      io.out(
        [
          `${p.sessions} Claude Code session${p.sessions === 1 ? '' : 's'} in this project ` +
            (scope.since ? `since ${localDay(scope.since)}` : 'over the whole history') +
            '.',
          `Reports on them: ${p.toWrite} to write` +
            (p.toWrite
              ? ` (about ${minutes(p.est.ms)} with ${REPORT_CONCURRENCY} at once, and about $${p.est.costUsd.toFixed(2)} at the API list price: on a subscription, tokens counted against the usage limits, not a bill)`
              : '') +
            `, ${p.kept} already written` +
            (p.plan.noPrompt ? `, ${p.plan.noPrompt} without any prompt typed by the user (not analysed)` : '') +
            (p.plan.current ? ', and this session (not analysed)' : '') +
            '.',
          MODE_LINE.reports,
        ].join('\n'),
      );
      // The periods to choose from, as lr retro scope lists them: what each one would cost.
      if (scope.options.length > 0) {
        const lines = ['', 'Periods to choose from (as lr retro scope lists them):'];
        for (const o of scope.options) {
          const x = o.since === scope.since ? p : await period(o.since);
          lines.push(
            `- ${o.label} (${o.flag || 'the default'}${o.proposed ? ', proposed' : ''}): ${x.sessions} session${x.sessions === 1 ? '' : 's'}, ` +
              `${x.toWrite} report${x.toWrite === 1 ? '' : 's'} to write` +
              (x.toWrite ? ` (about ${minutes(x.est.ms)}, about $${x.est.costUsd.toFixed(2)})` : '') +
              `, ${x.kept} already written`,
          );
        }
        io.out(lines.join('\n'));
      }
      return 0;
    }
    if (!id) throw new Error('missing <retro-id>');
    const book = new RetroBook(await retroHome(root, io.env));
    const retro = await book.get(id);
    const repos = retro.stores.map((s) => s.root);
    // Only the sources chosen when the retro started are read.
    const source = SOURCE_OF_ACTION[action];
    if (source && !retro.sources.includes(source)) {
      if (action === 'jev') throw new Error(`retro ${retro.id} does not read the review threads: nothing to classify`);
      io.out(
        `Skipped: retro ${retro.id} does not read ${SOURCE_WORDS[source]} (its sources: ${retro.sources.join(', ')}).`,
      );
      return 0;
    }
    if (action === 'conversation') {
      if (!threadId) throw new Error('missing <thread-id>');
      const { threads } = await retroThreads(retro, io.env);
      const found = threads.get(threadId);
      if (!found) throw new Error(`thread ${threadId} is not one of the threads of retro ${retro.id}`);
      const result = await threadConversations(found.thread, claudeDir);
      if (result.linked > 0)
        await book
          .record(retro.id, [
            { type: 'retro.conversation', thread: threadId, sessions: result.sessions, available: result.available },
          ])
          .catch(() => undefined); // e.g. a finished retro: reading back still helps
      io.out(result.text);
      return 0;
    }
    if (action === 'usage') {
      const own = await (io.session ?? currentSession)(io.env);
      const tools = await setupTools(retro.root, repos, home, claudeDir);
      const usage = await setupUsage(tools, claudeDir, retro.root, io.env, new Set(own ? [own] : []));
      await book.record(retro.id, [{ type: 'retro.usage', ...usage }]);
      const never = usage.tools.filter((t) => t.byUser + t.byAgent === 0);
      io.out(
        [
          `Usage of the ${usage.tools.length} skills, commands and sub-agents of the setup, from Claude Code's sessions ` +
            usage.windows
              .map(
                (w) =>
                  `(${w.scope === 'project' ? "the project's" : "every project's, for the user's tools"}: ${w.sessions} session${w.sessions === 1 ? '' : 's'})`,
              )
              .join(' ') +
            `: ${never.length} never used. lr retro input --for audit includes it.`,
        ].join('\n'),
      );
      return 0;
    }
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
    if (action === 'reports' || action === 'insights') {
      const wanted: SessionsMode = action;
      if (retro.sessionsMode !== null && retro.sessionsMode !== wanted) {
        io.out(
          `Skipped: this retro reads the sessions ${retro.sessionsMode === 'reports' ? 'through a report on each one' : "through Claude Code's /insights"} ` +
            '(setting retro-sessions when it started), never both.',
        );
        return 0;
      }
    }
    if (action === 'reports') {
      const transcripts = await projectTranscripts(claudeDir, retro.root, retro, io.env);
      const own = await (io.session ?? currentSession)(io.env);
      const plan = await planReports(book, transcripts, {
        retroId: retro.id,
        ...(own ? { exclude: new Set([own]) } : {}),
      });
      const done = await writeReports(book, plan, io.env, io.run);
      // What this run did, for the user; then, for the journal, a report written by an earlier run of
      // the same retro counts as written for it.
      const count = (status: string) => done.refs.filter((r) => r.status === status).length;
      const written = count('analysed');
      const kept = count('reused');
      const refs = await Promise.all(
        done.refs.map(async (ref) =>
          ref.status === 'reused' &&
          !ref.reason &&
          ((await readSessionReport(book, ref.id))?.generatedAt ?? '') >= retro.startedAt
            ? { ...ref, status: 'analysed' as const }
            : ref,
        ),
      );
      await book.record(retro.id, [
        {
          type: 'retro.reports',
          source: REPORTS_SOURCE,
          sessions: refs,
          durationMs: done.durationMs,
          ...(done.costUsd !== null ? { costUsd: done.costUsd } : {}),
          ...(done.tokens !== null ? { tokens: done.tokens } : {}),
        },
      ]);
      const failed = done.refs.filter((r) => r.status === 'failed');
      io.out(
        [
          `Reports on the ${done.refs.length} Claude Code session${done.refs.length === 1 ? '' : 's'} of this project in the period: ` +
            `${written} written, ${kept} kept from before` +
            (failed.length ? `, ${failed.length} could not be written` : '') +
            (written ? `, in ${minutes(done.durationMs)}` : '') +
            (done.costUsd !== null ? ` (about $${done.costUsd.toFixed(2)} at the API list price)` : '') +
            '. lr retro input --for analysis includes them.',
          ...failed.map((r) => `- ${r.id}: ${r.reason ?? 'failed'}`),
        ].join('\n'),
      );
      return written + kept > 0 || done.refs.length === 0 ? 0 : 1;
    }
    if (action === 'insights') {
      const ran = await runInsights(retro.root, io.env, io.run);
      // The retro's own session is not one of the sessions it looks back at.
      const own = await (io.session ?? currentSession)(io.env);
      const { sessions, files, read } = await projectSessions(
        join(claudeDir, 'usage-data'),
        retro.root,
        retro,
        io.env,
        io.run,
        new Set(own ? [own] : []),
      );
      if (files > 0 && read === 0) {
        io.err(
          `lr-retro: /insights has ${files} session file(s), but none could be read: its format changed. ` +
            'The retro goes on without the sessions; tell the user to report it as a bug of Local Review.',
        );
        return 1;
      }
      if (files === 0 && ran.kind === 'failed') {
        io.err(`lr-retro: /insights failed (${ran.reason}): the retro goes on without the sessions.`);
        return 1;
      }
      const file = await recordRetroSessions(
        book,
        retro.id,
        INSIGHTS_SOURCE,
        sessions,
        ran.kind === 'done' ? ran : { costUsd: null, durationMs: null },
      );
      const withSummary = sessions.filter((s) => s.summary).length;
      io.out(
        [
          `Written: ${file}`,
          `${sessions.length} Claude Code session${sessions.length === 1 ? '' : 's'} of this project in the period, ` +
            `${withSummary} with a summary by /insights: lr retro input --for analysis includes them.`,
          ...(ran.kind === 'failed' ? [`(/insights did not run: ${ran.reason}; its last results were used.)`] : []),
        ].join('\n'),
      );
      return 0;
    }
    if (action === 'audit') {
      const outcome = await runAudit(retro.root, claudeDir, io.env, io.run);
      if (outcome.kind === 'skipped') {
        io.out(`Audit skipped: ${outcome.reason}.`);
        return 0;
      }
      if (outcome.kind === 'failed') {
        io.err(`lr-retro: the audit failed: ${outcome.reason}.`);
        return 1;
      }
      const file = await writeRetroFile(
        book,
        retro.id,
        AUDIT_FILE,
        [
          `# Audit of the setup — ${AUDIT_COMMAND}`,
          '',
          `Run for the retro ${retro.id} in ${retro.root}, read-only (no shell, no edit), with access to ${claudeDir}.`,
          '',
          outcome.report,
          '',
        ].join('\n'),
      );
      const minutes =
        outcome.durationMs === null ? '' : ` in ${Math.max(1, Math.round(outcome.durationMs / 60_000))} min`;
      const cost = outcome.costUsd === null ? '' : ` (about $${outcome.costUsd.toFixed(2)})`;
      io.out(`Written: ${file}\nThe audit of the setup is done${minutes}${cost}.`);
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

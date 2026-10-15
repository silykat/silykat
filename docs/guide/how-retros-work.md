---
description: The details of a silykat retro, step by step. Sources and their settings, reports on your sessions, the analysis, measures, guard rails and costs.
section: reference
order: 3
---

# How a retro works

This page details each step of a retro. To run one, start with [Retros](./retros.md).

## The sources and their settings

A retro reads one or more sources: your **reviews**, your **sessions** with Claude, and the **audit** of your setup. Each source has a setting:

| Value | Meaning                         |
| ----- | ------------------------------- |
| `yes` | Always read it                  |
| `no`  | Never read it                   |
| `ask` | Ask at each retro (the default) |

The project's settings come first, then the machine's, then `ask`.

- **The project's settings** are asked at its first retro and saved in its `.silykat/config.json` (yours only). Change one with `slk config set retro-source-audit no --project`.
- **The machine's settings** are **Retro Sources** in VS Code, or `slk config set retro-source-reviews yes|no|ask`.

For a source set to `ask`, Claude asks only when it makes sense: the reviews and the sessions when the period has some, the audit always. With no source left, there is nothing to look back at, and no retro starts.

## Your sessions: reports or insights

A retro reads your sessions in one of two ways, set for the whole machine by **Retro Sessions** (`silykat.retroSessions`, or `slk config set retro-sessions reports|insights`).

### `reports` (the default, finer)

Claude writes a **report on each session** of the project and of the period where you typed at least one prompt.

1. First, silykat finds, without a model, the **signals** of the session: corrections, interruptions, refusals, your edits of Claude's work, Claude's questions, permission blocks, failing commands, skills and sub-agents used, the prompts you typed, commits and pull requests.
2. Then a model reads the conversation around those moments only, with secrets masked, and writes the report: what you wanted and how it went, what to improve, what recurs, leads.

Reports are kept in `.silykat/retros/sessions/`. The next retro reuses them, and writes a new one only for a session that went on since.

A very long session (roughly 180 prompts and more) would take more than 20 minutes to read: it is **left out** before anything is spent, and the choice of the period flags it with ⚠️. If it already has a report from when it was shorter, that report is read instead.

### `insights` (cheaper, less precise)

The retro runs Claude Code's own `/insights`, which keeps counts and short summaries of each session of the machine. The retro keeps only the sessions of the project and of the period. If `/insights` fails, the retro goes on without your sessions.

In both ways, the retro's own session and the sessions run by a program (`claude -p`) are left out.

## The audit and the usage of your tools

The audit runs Claude Code's `/doctor prompt-audit` on your `CLAUDE.md` files, skills, agents and commands, the project's and those of `~/.claude`. It only reads.

Alongside, silykat counts, without a model, how many times each skill, command and sub-agent was used, by you or by Claude. It only sees this machine, and the sessions Claude Code still keeps (30 days by default).

## The analysis

1. When the retro includes your reviews, the threads are sorted by kind of feedback (by Jev with a key, otherwise by Claude).
2. Each source is read on its own: the threads, grouped by cause; your sessions, for what recurs from one to the next; the audit, with the usage of your tools.
3. Last, all findings are weighed against each other, with your setup and your previous retros. A lead seen in two sources gains weight. When two sources seem to disagree, the analysis goes back to the source to settle it.

When a thread is ambiguous, the conversation where Claude replied is read back. Claude Code deletes conversations after 30 days by default (the `cleanupPeriodDays` setting): an older one is no longer available, and the retro says so.

## Did last time's changes help?

From the second retro on, each change you adopted is measured on the sources it came from: the threads on its subject out of all threads, and the sessions that show it out of all sessions, before and since.

- **Stopped** or **decreased**: the change is kept.
- **Did not decrease**: the retro proposes to revise it (reword the rule, move it up, make it a hook, or remove it).
- **Not measured**: none of its sources has data in the new period, or the change came from the audit alone. The retro says so.

## Guard rails

These rules are checked by program, whatever the agent does:

- A proposal needs at least 2 pieces of evidence (threads or sessions), or a finding of the audit to remove or rewrite a rule.
- A session cited must be one of the retro's, quoted word for word.
- A rule you had to enforce during the period is never proposed as "keep".
- One subject per proposal. A problem seen in several sources is raised once.
- A subject you excluded comes back only if new feedback raises it.
- Leads seen once and confirmed nowhere else are kept **to watch**, not proposed.
- A proposal that rests on your sessions only says so: a summary written by a model is not your own words.

## What a retro records

Each retro is recorded in `.silykat/retros/` at the top of the project: the period, the sources, the threads and sessions read, the proposals, your decisions, exclusions and preferences. The next retro starts from it.

```sh
slk retro list
slk retro show <id>
```

## Time and cost

The recap gives the estimated time before you start, and the end of the retro says what it took, as an equivalent at API list prices. On a subscription, these are tokens counted against your usage limits, not a bill.

Orders of magnitude, measured during development in October 2026 (silykat 0.11 and earlier):

- **The audit**: about 4 minutes and $1.70 at API prices with Sonnet, on a project with a few rules files and a large `~/.claude`. More with Opus.
- **A session report**: about a minute and a half and $0.40 with Opus, on a session of 9 prompts. Longer sessions take more.
- **`insights`**: about a minute.

These figures are rough estimates, to be refined on real retros.

## Under the hood

- The retro runs in sub-agents with a fresh context, so that your session keeps its own for the discussion.
- The readings of each source and the analysis use Opus, for the most careful reasoning. The sorting of threads uses Haiku without a Jev key.
- The audit and each session report run in a separate, read-only Claude Code (no shell, no edits). Session reports run 4 at once, the longest first.
- The findings of each source share one format (cause, evidence, suggested change, confidence), checked by `slk`.
- Changes are applied by a sub-agent in the background, exactly as you validated them.

See [the architecture](https://github.com/silykat/silykat/blob/main/docs/architecture.md) for more.

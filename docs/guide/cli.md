---
description: slk, the silykat command line that Claude uses to read and answer your threads, and that you can run to see what it sees.
section: reference
order: 2
---

# The slk command line

`slk` is the silykat command line. Claude uses it to read your threads and answer them. It comes with the Claude Code plugin.

You rarely need it: you can ask Claude instead (`show me this week's review comments`, `is a retro due?`). It is handy to see exactly what Claude sees.

## Run it

`slk` is on the `PATH` of your Claude Code sessions. In a Claude Code session, type it after the `!` prefix:

```text
! slk review status
```

Its output also goes into the conversation, so Claude sees it too. `slk --help` has the full reference.

## Review

| Command                                                | What it does                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------ |
| `slk review status`                                    | How many threads wait for the agent, and for you                   |
| `slk review list [--all] [--thread <id>]…`             | The threads waiting for the agent, with their current code         |
| `slk review show <thread-id>`                          | One thread in full                                                 |
| `slk review reply <thread-id> --agent <name> --body -` | Reply (body on stdin), optionally `--status addressed\|needs-info` |

## History, archive and clean-up

| Command                                                                   | What it does                                                            |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `slk review history [--since <date>] [--out <file>]`                      | Every thread of the project, whatever its state, in full (export)       |
| `slk review archive <id>…`, `slk review archive --resolved-before <date>` | Archive threads (`--list`: the archived ones)                           |
| `slk review unarchive <id>…`                                              | Bring archived threads back                                             |
| `slk review purge --before <date> [--yes]`                                | Delete old finished threads for good (without `--yes`: only says which) |
| `slk review purge --history [--yes]`                                      | Erase the history kept: deleted threads, threads saved from worktrees   |
| `slk worktree save [<folder>]`                                            | Save a git worktree's threads before removing the worktree              |

Dates are `2026-10-01`, or a number of days ago (`30d`). See [History, archive and clean-up](./history.md).

## Subscriptions and sessions

| Command                                                | What it does                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `slk subscribe [<folder>] [--path]`, `slk unsubscribe` | Subscribe the session `slk` runs in to the branch of a folder, or to a path, or stop |
| `slk subscriptions`                                    | What this session is subscribed to                                                   |
| `slk sessions`                                         | The running agent sessions                                                           |

See [Working with Claude](./working-with-claude.md#which-sessions-get-your-comments).

## Retros

| Command               | What it does                                                              |
| --------------------- | ------------------------------------------------------------------------- |
| `slk retro cadence`   | Is a retro due? Days, size of the threads and sessions since the last one |
| `slk retro scope`     | What a retro would cover                                                  |
| `slk retro list`      | The past retros of the project                                            |
| `slk retro show <id>` | A retro and its proposals                                                 |
| `slk retro sources`   | The settings of the sources of a retro, for this project                  |
| `slk retro key`       | Is the Jev key set up, and safely? (never reads it)                       |

The other `slk retro` commands are steps of a retro, run by Claude. See [Retros](./retros.md).

## Settings

| Command                         | What it does                                                       |
| ------------------------------- | ------------------------------------------------------------------ |
| `slk config`                    | The settings of this machine                                       |
| `slk config set <name> <value>` | Change one (see [Settings](./settings.md#settings-of-the-machine)) |
| `slk config --project`          | The settings of the project, which come first                      |

## Options

- `--root <folder>` targets a project from elsewhere. `--root /` targets the files outside the open folders.
- `--format json` gives the output to tools.

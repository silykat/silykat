---
description: Where silykat keeps your comments, retros and settings, as plain files on your machine. No telemetry, and one opt-in exception for retros.
section: reference
order: 4
---

# Data and privacy

Everything silykat writes stays on your machine, in plain files you can read. There is no server, no account and no telemetry.

## Nothing leaves your machine

silykat makes no network call and collects no telemetry.

The one exception is opt-in: if you set up a [Jev key](./retros.md#the-jev-key-optional), a retro sends your threads to Jev to sort them. Only during a retro, and only with a key.

Your agent is a separate matter: Claude Code sends what it reads to Anthropic, as in any session. silykat does not change that.

## Where your data lives

### In your project

| What                                   | Where                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------- |
| Your comments                          | `.silykat/` at the root of the project (the git repository, or the open folder) |
| Your retros and your retro preferences | `.silykat/retros/` at the top of the project                                    |
| The project's own settings             | `.silykat/config.json`                                                          |
| Threads saved from git worktrees       | `.silykat/saved/` of the main repository                                        |

git ignores `.silykat/`: silykat adds it to `.git/info/exclude` on your first comment. It never touches `.gitignore`, so your comments are never committed unless you choose to.

### On your machine

| What                                          | Where                                                        |
| --------------------------------------------- | ------------------------------------------------------------ |
| Comments on files outside the open folders    | `~/.silykat/files/`                                          |
| Settings of the machine (`slk config`)        | `~/.silykat/config.json`                                     |
| Agent sessions, subscriptions, message queues | `~/.silykat/sessions/`                                       |
| Agent sessions seen, for the retro reminder   | `~/.silykat/agent-sessions.jsonl`                            |
| The Jev key, if you set one up                | `~/.config/silykat/jev-key` (proposed), readable by you only |

Set `SILYKAT_HOME` to move `~/.silykat/` elsewhere.

## What is kept, and how to erase it

- **Deleting or archiving** a thread keeps it on disk, for your history and your retros. Turn [Keep history](./history.md#keep-or-erase-what-you-delete) off to erase instead.
- **Delete Old Threads Permanently** removes old finished threads for good. See [History, archive and clean-up](./history.md#delete-old-threads-for-good).
- **Reports on your sessions**, written by retros, are kept in `.silykat/retros/sessions/` for the next retro. Keep history does not touch them.

## Under the hood

Comments are stored as append-only journals, in JSON Lines: every change adds a line, nothing is rewritten. The format is described in [the architecture](https://github.com/silykat/silykat/blob/main/docs/architecture.md).

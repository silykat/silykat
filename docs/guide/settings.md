---
description: Every silykat setting for VS Code, grouped by use (comments, agents, history, retros), with its default value and its slk config equivalent.
section: reference
order: 1
---

# Settings

Open the VS Code settings and search for **silykat**. The defaults suit most people.

## Comments

| Setting                      | Default      | What it does                                                                                                                |
| ---------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `silykat.userName`           | _(empty)_    | Name shown on your comments. Empty: `git config user.name`, else your OS user name.                                         |
| `silykat.commentShortcut`    | `ctrl+cmd+c` | Shortcut of **Comment on Selection**: `ctrl+cmd+c`, `ctrl+alt+c`, `cmd+alt+m` or `none` (then bind it yourself, see below). |
| `silykat.notifyOnAgentReply` | `true`       | Notify you when the agent replies. The status bar counter of threads waiting for your reply always shows.                   |
| `silykat.excludeFromGit`     | `true`       | Add `.silykat/` to `.git/info/exclude` on the first comment. Never touches `.gitignore`.                                    |

`ctrl+cmd+c` is `Ctrl+Alt+C` on Windows and Linux. For any other key, choose `none` and bind the `silykat.commentSelection` command in **Preferences: Open Keyboard Shortcuts**.

## Agents

| Setting                | Default | What it does                                                                                   |
| ---------------------- | ------- | ---------------------------------------------------------------------------------------------- |
| `silykat.pushToAgents` | `true`  | Send what you publish to the subscribed agent sessions. Off: nothing is sent, and no warnings. |

See [Working with Claude](./working-with-claude.md).

## History

| Setting               | Default | What it does                                                                                                                        |
| --------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `silykat.keepHistory` | `true`  | Keep deleted threads (for your history and retros), and save a worktree's threads before an agent removes it. Off: deleting erases. |

See [Keep or erase what you delete](./history.md#keep-or-erase-what-you-delete).

## Retros

| Setting                              | Default   | What it does                                                                                      |
| ------------------------------------ | --------- | ------------------------------------------------------------------------------------------------- |
| `silykat.retroSources.reviews`       | `ask`     | Whether a retro reads your review threads: `yes`, `no`, or `ask` at each retro.                   |
| `silykat.retroSources.sessions`      | `ask`     | The same for your sessions with the agent.                                                        |
| `silykat.retroSources.audit`         | `ask`     | The same for the audit of your setup.                                                             |
| `silykat.retroSessions`              | `reports` | How a retro reads your sessions: `reports` (a report on each one, finer) or `insights` (cheaper). |
| `silykat.retroReminder.days`         | `7`       | A retro is due this many days after the last one.                                                 |
| `silykat.retroReminder.sizeKB`       | `1000`    | Or sooner, once the review threads since the last retro weigh this many KB (1000 = 1 MB).         |
| `silykat.retroReminder.maxDays`      | `25`      | And never later than this many days.                                                              |
| `silykat.retroReminder.statusBar`    | `always`  | The retro reminder in the status bar: `always`, `whenDue` or `never`.                             |
| `silykat.retroReminder.agentMessage` | `true`    | When a retro is due, Claude says so once at the start of a session.                               |

A project's own retro sources, asked at its first retro, come before these. See [How a retro works](./how-retros-work.md#the-sources-and-their-settings).

## Settings of the machine

Claude runs outside VS Code, so it reads some settings from the machine instead: history and everything about retros. When you change one of them in VS Code, the extension writes it to the machine too.

Without VS Code, change them with `slk config`:

| VS Code setting                      | `slk config set …`                   |
| ------------------------------------ | ------------------------------------ |
| `silykat.keepHistory`                | `keep-history on\|off`               |
| `silykat.retroSessions`              | `retro-sessions reports\|insights`   |
| `silykat.retroSources.reviews`       | `retro-source-reviews yes\|no\|ask`  |
| `silykat.retroSources.sessions`      | `retro-source-sessions yes\|no\|ask` |
| `silykat.retroSources.audit`         | `retro-source-audit yes\|no\|ask`    |
| `silykat.retroReminder.days`         | `retro-reminder-days <days>`         |
| `silykat.retroReminder.sizeKB`       | `retro-reminder-size <KB>`           |
| `silykat.retroReminder.maxDays`      | `retro-reminder-max-days <days>`     |
| `silykat.retroReminder.agentMessage` | `retro-reminder on\|off`             |

A value set in VS Code wins over one set with `slk config`. Run `slk config` to see the current values. See [The slk command line](./cli.md).

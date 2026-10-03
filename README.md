# Local Review

**A GitHub-style code review between you and your AI coding agent, 100% local.**

Select lines in VS Code, leave comments like on a pull request, and your agent reads them, changes the code and answers in the threads. No pull request, no server, no account: comments live next to your code, and nothing leaves your machine (unless you opt in to an online classifier for your retros).

Local Review is agent-agnostic by design; **Claude Code** is the first supported agent.

```text
  You, in VS Code                        Your agent (Claude Code)
  ───────────────                        ────────────────────────
  comment lines, a file, a diff   ──▶    receives the comments on its own
  or submit a whole review               changes the code
  see the answers live            ◀──    replies in each thread: done, or a question
  resolve when satisfied
```

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Using Local Review](#using-local-review)
- [Working with agents](#working-with-agents)
- [Retros](#retros)
- [Settings](#settings)
- [The `lr` command line](#the-lr-command-line)
- [Where your data lives](#where-your-data-lives)
- [Known limitations](#known-limitations)
- [Contributing](#contributing)
- [License](#license)

## Features

- **Comments anywhere**: selected lines, a whole file, both sides of a diff (working tree, staged changes, past commits, file comparisons), even files outside the folders open in VS Code.
- **Direct comments or reviews**: publish a comment right away, or collect drafts and submit them as one review with a summary.
- **Threads that follow the code**: they move with the lines, find their code again after external changes, and turn **Outdated** when it is gone, like on GitHub.
- **Threads that belong to their git branch**: switch branches and you only see that branch's threads; each branch has its own review.
- **Your agent does the work**: it receives what you publish, changes the code, replies in each thread, and tells you what it did or what it needs.
- **The right agent gets it**: with several agent sessions in parallel (one per git worktree, a reviewer next to a developer…), each comment goes to the sessions working on its branch.
- **Safe while the agent works**: edit or delete a comment at any time; the agent never answers an outdated version.
- **Your whole history**: read back every thread of a project, resolved and deleted ones included, across its repositories and worktrees (`lr history`). It tells a thread you removed from one gone with its branch, and keeps the threads of a git worktree after you remove it, once saved (automatically when your agent removes it). **Archive** finished threads to clear VS Code without losing them, export everything to JSON, or delete old threads for good.
- **Retros with your agent**: look back at your feedback with Claude, and decide together what to keep, remove or improve in its setup (`CLAUDE.md`, skills, hooks…); Claude applies what you validate (`/local-review:retro`). The next retro checks whether the changes helped, and the status bar tells you when a retro is due.
- **100% local**: no network calls, no telemetry, plain files you can read. The one exception is opt-in: the classification of a retro by Jev, only if you give it a key.

## Requirements

- **VS Code** 1.100 or later (or an editor based on it: see [Other editors based on VS Code](#other-editors-based-on-vs-code-cursor-vscodium-windsurf)).
- **Node.js** 22.12 or later, with **npm** 11.10 or later, and **git**, to build the extension (it is not on the Marketplace yet).
- For the agent integration: **Claude Code** in a terminal, logged in with a claude.ai account (Pro or Max) or a Console API key. Team and Enterprise organizations must enable channels (see [Known limitations](#known-limitations)).

## Installation

### 1. The VS Code extension

```sh
git clone git@github.com:lbenamer/local-review.git
cd local-review
npm install
npm run install-ext
```

This builds `packages/vscode-extension/dist/local-review.vsix` and installs it with the `code` command (it must be on your PATH: in VS Code, **Shell Command: Install 'code' command in PATH**). Then reload VS Code (**Developer: Reload Window**).

#### Other editors based on VS Code (Cursor, VSCodium, Windsurf…)

These editors are not tested yet. The editor must be based on VS Code 1.100 or later.

1. Build the extension without installing it:

   ```sh
   npm run package
   ```

2. In the editor, run **Extensions: Install from VSIX…** from the Command Palette, and pick `packages/vscode-extension/dist/local-review.vsix`.
3. Reload the editor (**Developer: Reload Window**).

The Claude Code plugin (next step) does not depend on the editor.

### 2. The Claude Code plugin

```sh
claude plugin marketplace add lbenamer/local-review
claude plugin install local-review@local-review
```

The repository is private for now: this needs git access to it. To update later:

```sh
claude plugin marketplace update local-review
claude plugin update local-review@local-review
```

### 3. Launch Claude Code with the Local Review channel

The channel is what lets your comments reach Claude by themselves. Channels are a Claude Code research preview, so the launch command is long: add an alias, e.g. to `~/.zshrc`:

```sh
alias claude-lr='claude --dangerously-load-development-channels plugin:local-review@local-review'
```

At each launch, Claude Code warns about development channels: choose **I am using this for local development**.

## Quick start

1. Open your project in VS Code, and start `claude-lr` in a terminal, in the same repository (or any worktree of it).
2. Ask Claude to change something. As soon as it modifies a file, it is **subscribed** to that branch and says so.
3. In VS Code, select the lines you want to comment on and press **`Ctrl+Cmd+C`** (`Ctrl+Alt+C` on Windows/Linux), or right-click → **Local Review: Comment on Selection**. Type your comment and click **Comment**.
4. Claude receives it within seconds, changes the code and replies in the thread: **✅ Addressed by Claude — please verify**, or **❓ Claude is waiting for your reply**. The first time, Claude asks to use the `local-review:review` skill: allow it for good.
5. Check the change, reply if needed, and **Resolve** the thread (✓ in its header). Only you resolve threads.

## Using Local Review

### Comments

- **On lines**: select them, then **`Ctrl+Cmd+C`** or **Local Review: Comment on Selection** (editor context menu or command palette).
- **On a whole file**: right-click its tab → **Local Review: Comment on File**. The thread has no line and shows at the top of the file.
- **Reply** in a thread (**Reply**, or `Cmd+Enter`), **Edit** or **Delete** your own comments, **Delete Thread** from its header. Agent comments are read-only.
- **Resolve** closes a thread and collapses it; **Reopen**, or replying in it, hands it back to the agent.

Markdown is supported. The **Comments** panel of VS Code lists every thread and can hide resolved ones. When the agent replies, a notification says where, and the status bar counts the threads waiting for your reply.

### Review mode

Click **Start Review** instead of **Comment**: the comment becomes a **Pending** draft and the status bar shows **Review · N**. Add more with **Add to Review** (or publish one right away with **Comment Now**). Click the status bar to **Submit Review**, with an optional summary, to **Show Pending Comments**, or to **Discard Review**. The agent sees nothing until you submit. Drafts survive a restart.

What a review covers:

- **Files tracked by git**: the branch. There is one review per branch: every file of the branch can join it (see [Branches and worktrees](#branches-and-worktrees)).
- **Files not tracked by git** (outside any repository, or ignored by git): the folder that directly holds the file. There is one review per folder, so `specs/a.md` and `specs/b.md` share a review, while `notes/c.md` gets its own. Comments on a file of another folder offer **Start Review** again.

When several reviews are in progress, the status bar shows the review of the file you have open (**Review · N**), or **N reviews** when that file has none.

### Diffs

Comment in any diff: your changes (click a file in **Source Control**, both sides, including deleted lines), staged changes (`HEAD` ↔ index), a past commit (from the **Timeline**), or two files compared (**Select for Compare** → **Compare with Selected**). A thread on an older version says which one in its header (**Index**, **HEAD a92bf1e**), and **Open Original Diff** reopens that exact diff later.

### Threads follow the code

Threads move with the lines when you edit above or inside them; the new position is recorded when you save. When the file changes outside the editor (`git stash`, another tool, while VS Code was closed), the thread finds its code again. When its code is gone, it becomes **⚠️ Outdated**: it moves to line 1 and quotes the original code; it attaches again by itself if the code comes back.

### Branches and worktrees

A thread belongs to the branch of its file. After `git checkout`, VS Code shows only the threads of the branch checked out; the others come back with their branch. Each worktree has its own branch, and there is **one review per branch** (one per folder for files not tracked by git, see [Review mode](#review-mode)): the status bar and **Submit Review** act on the review of the file you have open. Renaming a branch keeps its threads; deleting it deletes them (the history records them as deleted **with their branch**, not as removed by you). Files ignored by git, and files outside git, are on no branch: their threads always show.

#### Removing a worktree

`git worktree remove` deletes the worktree's folder, and its comments with it (they are in its `.local-review/`). The first time a worktree you open has comments, VS Code tells you so. Before removing it, run **Local Review: Save Worktree Threads** (or `lr worktree save` in the worktree, or **Save Threads Now** in that message): its threads are copied to the store of the main repository, with the worktree and branch they come from, and stay in the history and in retros after the worktree is gone. Saving again refreshes the copy; nothing is removed from the worktree, and VS Code does not show the copies.

When your agent is about to remove a worktree (`git worktree remove`, `rm -r` of the worktree, or Claude Code's own worktrees left with "remove"), the Claude Code plugin saves its threads first and Claude tells you so. To turn that off: `lr config set auto-save-worktrees off` (Claude then warns you instead).

### Archive and clean up

Finished threads can leave VS Code without leaving your history:

- **Archive Thread** (in a thread's header), or **Local Review: Archive Resolved Threads…** for every thread resolved before a date (`2026-10-01`, or `30d` for 30 days ago; it says how many first). Archived threads disappear from VS Code and from what your agent sees (`lr list`), and stay in `lr history` and in retros.
- **Local Review: Show Archived Threads** lists them: pick the ones to bring back.
- **Local Review: Export Threads (JSON)…** writes every thread of the open folders, whatever its state, archived ones included, to a JSON file: keep it before a clean-up.
- **Local Review: Delete Old Threads Permanently…** deletes for good the **finished** threads (resolved, archived or deleted) where nothing happened since a date, after a confirmation that says how many. Threads still in progress are kept, however old. This cannot be undone: they are gone from the history and from retros too.

These act on each open folder as `lr history` does (its subfolders and the worktrees of its repositories), and on the files outside the open folders. Your agent can do the same for you: ask it to "archive my resolved comments of last month" or to "delete the comments older than 3 months" (it tells you how many and waits for your yes; Claude Code then asks you to allow the deletion itself). An older version of Local Review shows an archived thread read-only, and asks to be updated.

### Files outside the open folders

A file in none of the folders open in VS Code (e.g. a spec your agent wrote in a parent folder) can be commented like any other. Its threads are kept on your machine, with the file's full path, and show in any VS Code window where you open it.

## Working with agents

### What the agent does

When a comment reaches Claude, it follows the `local-review:review` skill: it reads the threads waiting for it with their current code, then for each one either applies the request and replies **addressed**, or asks one precise question (**needs-info**) without touching the code, or explains a disagreement. It ends with a short summary. You can also ask for it at any time: **`/local-review:review`**.

Each reply keeps the link to the conversation it was written in: the id of the Claude Code session, and of the step that wrote it. `lr history` shows it (resume that conversation with `claude --resume <session id>`, from the folder it ran in), and a retro reads it back to understand an ambiguous thread.

### Sessions and subscriptions

Every Claude Code session started with the plugin registers itself; VS Code shows the sessions of your workspace in the status bar, each with its short id (e.g. **Claude a1b2c3d4**). **Local Review: Show Agent Sessions** lists them all, with what each one is subscribed to.

A comment goes to **every session subscribed** to its git branch (or, outside git, to its file or folder). A session subscribes:

- when it is **started in a git worktree** (to its branch);
- when it **modifies a file** (to that file's branch; outside git, to the file), with its editing tools or a shell command;
- when **you ask it**: "subscribe to this branch", "subscribe to this folder", "unsubscribe", "what are you subscribed to?" (or `/local-review:subscribe`, `/local-review:unsubscribe`).

Reading files or moving to a folder does not subscribe. Claude tells you whenever a subscription changes. Two sessions on one branch (e.g. a developer and a reviewer) both get its comments: what each one does with them is up to it.

When **nobody is subscribed** to what you publish, VS Code asks first: cancel, publish anyway (saved, sent to nobody: an agent reads it when you ask), or publish without being asked again for that folder until VS Code closes.

### Editing or deleting while the agent works

Editing or deleting a published comment tells the subscribed sessions too. Claude Code hands the change to Claude between two of its steps: it adapts its work to the new version, or, for a deleted thread, stops working on it and asks you before undoing anything. A thread the agent had addressed goes back to it, and the comment shows **edited after Claude replied**. The agent can never answer an outdated version: `lr` refuses a reply to a thread that changed since the agent read it.

### Without the channel

A session started without the channel (plain `claude`, or the Claude Code panel of VS Code) still receives the comments, but only sees them when you ask it (`/local-review:review`). VS Code tells you once, with the command to relaunch it, and marks the session with ⚠ in the status bar. To send nothing to the sessions at all, turn off `localReview.pushToAgents`.

## Retros

A retro is a look back at the review feedback you gave your agent since the last retro, to improve its setup from what really happened, like a sprint retro with your agent. It is a discussion: nothing changes without your say-so, and what you validate, Claude applies.

### Running a retro

In a Claude Code session started in your working folder (the **project**: that folder, its subfolders, every repository in it and their git worktrees), run **`/local-review:retro`**, or ask for a retro. Then:

1. **The last retro** (from the second one on): Claude asks whether you noticed the improvements decided then, and whether you want to change anything in the retro itself (what it looks at, its level of detail, subjects to ignore…). Your wishes become the **retro preferences** of the project, applied from now on.
2. **The scope**: the period (since the last retro; for a first one, Claude proposes the last 7 days, 30 days or everything), the comment stores found, the number of threads, the size of the data and an estimate of the time. You confirm.
3. **The analysis**, in two sub-agents with a fresh context, so that the session keeps its own for the discussion: one **classifies** the threads (Jev with a key, else Haiku), the other **analyses** all the threads together with your setup (rules files, skills, commands, sub-agents, hooks of the project and of `~/.claude`), the classification, statistics and the previous retros. When a thread is ambiguous (why did Claude do that?), it reads back the conversation where Claude replied: the request, the files read, the commands and edits, the skill in use. Claude Code deletes its conversations after 30 days by default (the `cleanupPeriodDays` setting): an older one is no longer available, and the retro says so and does without it. The retro tells you which conversations it read back.
4. **Did last time's changes help?** (from the second retro on): for each change you adopted at the last retro, the analysis names the threads of the new period with the same cause, and `lr` computes the numbers: the threads on its subject out of all the threads, before and since. The feedback **stopped** or **decreased**: the change is kept. It **did not decrease**: the retro proposes to revise it (reword the rule, move it up, make it a hook, or remove it). Claude shows it first, next to what you said you felt.
5. **The proposals**, in three columns, **To keep**, **To remove** and **To improve**. Each one shows its source (the threads, with an excerpt), its numbers (threads, reopened, questions, back-and-forth), the rule or file concerned, why, the change, its target and its confidence. Preferences seen in a single thread are kept **to watch**. For stale or contradictory rules, Claude suggests `/doctor prompt-audit` (Claude Code 2.1.283 or later).
6. **The discussion**, one proposal at a time (those that revise a change of the last retro first): accept, modify, exclude, or change its target: **project, shared** (the repository's `CLAUDE.md` or `.claude/`, for the team), **project, personal** (`CLAUDE.local.md`, yours only) or **you, everywhere** (`~/.claude/`). You can also just talk it through.
7. **Claude applies** what you validated, one change per subject, and ends with the list of files changed.

Guard rails are checked by program (in `lr`, whatever the agent): a proposal needs at least 2 threads; a rule you had to enforce during the period is never proposed as "keep"; one subject per proposal; the target is asked when nothing in your threads tells it; a subject you excluded comes back only if new feedback raises it; every change adopted at the last retro is checked, and one that did not reduce the feedback (with 2 threads or more) gets a proposal to revise it.

Each retro is recorded in `.local-review/retros/` at the top of the project (or of its repository): the period, the threads read, the proposals, your decisions, exclusions and preferences. The next retro starts from it. `lr retro list` and `lr retro show <id>` read them back.

### When to run a retro

A retro is worth it about once a week: with too little feedback there is not much to learn, with too much the analysis reads it less finely. Local Review keeps count of the **days** since the last retro and the **size** of the review threads since then (the threads it would read), and reminds you:

- in the **status bar** of VS Code, e.g. `Retro: 6 d · 640.0 KB`, which becomes `Retro due: 8 d · 1.2 MB` once a retro is due; click it to see how to run one (and copy `/local-review:retro`). It is hidden while there is nothing new since the last retro;
- in **Claude's first reply** of a new session started in the project, once: Claude tells you a retro is due and suggests `/local-review:retro` (it does not start it on its own).

A retro is due after **7 days**, or sooner once the threads weigh **1 MB**, and never later than **25 days**, so that the retro can still read back the conversations linked to replies (Claude Code deletes them after 30 days by default). The count starts after the last retro of the folder, or of a folder above it (a retro covers the subfolders), in this git worktree or another one of the same repository; before any retro, it starts at the first thread. Change these thresholds in the settings below; `lr retro cadence` tells where things stand.

### The Jev key (optional)

[Jev](https://jevtypesafeai.com/) classifies the threads faster and cheaper than a model of your subscription; without a key, Haiku does it. At your first retro, Claude offers to set it up: it proposes `~/.config/local-review/jev-key` and gives you a command to run **in your own terminal**, which asks for the key without showing it and saves it in a file only you can read. The key never goes through the conversation, and is never written in a journal or an output. Claude then checks, without reading it, that the file is readable by you only and is in no repository (`lr retro key`). `JEV_API_KEY` works too. This classification is the only network call of Local Review, made only during a retro, and only with a key.

## Settings

| Setting                                  | Default      | Description                                                                                                                                  |
| ---------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `localReview.userName`                   | _(empty)_    | Name shown on your comments. Empty: `git config user.name`, else your OS user name.                                                          |
| `localReview.commentShortcut`            | `ctrl+cmd+c` | Shortcut of **Comment on Selection**: `ctrl+cmd+c`, `ctrl+alt+c`, `cmd+alt+m` or `none` (then bind `localReview.commentSelection` yourself). |
| `localReview.notifyOnAgentReply`         | `true`       | Notify when the agent replies. The status bar counter of threads waiting for your reply is always shown.                                     |
| `localReview.excludeFromGit`             | `true`       | Add `.local-review/` to `.git/info/exclude` on the first comment. Never touches `.gitignore`.                                                |
| `localReview.pushToAgents`               | `true`       | Send what you publish to the subscribed agent sessions. Off: nothing is sent, and no session warnings are shown.                             |
| `localReview.retroReminder.days`         | `7`          | A retro is due this many days after the last one.                                                                                            |
| `localReview.retroReminder.sizeKB`       | `1000`       | Or sooner, once the review threads since the last retro weigh this many KB (1000 = 1 MB).                                                    |
| `localReview.retroReminder.maxDays`      | `25`         | And never later than this many days, whatever `days` says.                                                                                   |
| `localReview.retroReminder.statusBar`    | `always`     | The retro reminder in the status bar: `always`, `whenDue` or `never`.                                                                        |
| `localReview.retroReminder.agentMessage` | `true`       | When a retro is due, Claude says so once at the start of a session.                                                                          |

The agent's reminder runs outside VS Code: when you change a `retroReminder` setting in your user settings, the extension also writes it to the settings of the machine (`lr config`), which the agent reads. Without VS Code, set them with `lr config set retro-reminder-days 10` (and `retro-reminder-size`, `retro-reminder-max-days`, `retro-reminder on|off`). A value set in VS Code wins over one set with `lr config`.

## The `lr` command line

Agents read and answer the threads with `lr`, an agent-neutral command line; the Claude Code plugin puts it on Claude's `PATH`. You rarely need it yourself, but it is handy to see what the agent sees:

| Command                                                   | What it does                                                            |
| --------------------------------------------------------- | ----------------------------------------------------------------------- |
| `lr status`                                               | How many threads wait for the agent, and for you                        |
| `lr list [--all] [--thread <id>]…`                        | The threads waiting for the agent, with their current code              |
| `lr show <thread-id>`                                     | One thread in full                                                      |
| `lr reply <thread-id> --agent <name> --rev <v> --body -`  | Reply (body on stdin), optionally `--status addressed\|needs-info`      |
| `lr subscribe [<folder>] [--path]`, `lr unsubscribe`      | Subscribe the session `lr` runs in to a branch or a path, or stop       |
| `lr subscriptions`, `lr sessions`                         | What this session is subscribed to; the running sessions                |
| `lr history [--since <date>] [--out <file>]`              | Every thread of the project, whatever its state, in full (export)       |
| `lr archive <id>…`, `lr archive --resolved-before <date>` | Archive threads (`--list`: the archived ones); `lr unarchive <id>…`     |
| `lr purge --before <date> [--yes]`                        | Delete old finished threads for good (without `--yes`: only says which) |
| `lr worktree save [<folder>]`                             | Save a git worktree's threads before removing the worktree              |
| `lr config`, `lr config set <name> <value>`               | The settings of this machine (`auto-save-worktrees`, retro reminder)    |
| `lr retro scope`, `lr retro show <id>`, `lr retro list`   | What a retro would cover; a retro and its proposals; past retros        |
| `lr retro cadence`                                        | Is a retro due? Days and size of the threads since the last retro       |

Add `--root <folder>` to target a project from elsewhere (`--root /` for files outside the open folders), and `--format json` for tools. `lr --help` has the full reference.

### The history of your comments

`lr history` reads back **every thread of a project**, whatever its state: open, addressed, resolved or deleted, archived or not, each with its whole conversation (comments, status changes, dates, comments deleted since), its branch, its file and the commented code. The project is the current folder (or `--root <folder>`), its subfolders, and the git worktrees of the repositories it contains, even when they are kept next to it: run it from the parent folder of several repositories to get them all. `--since 2026-10-01` (or `--since 7d`) keeps the threads active since that date. Each agent reply shows the session it was written in (and the step, when known). Deleted threads say why: **removed by you**, or **gone with their branch** (threads deleted before Local Review recorded it say "reason unknown"). Threads saved from a worktree are listed under **saved from a worktree**, with their worktree and the day they were saved; while the worktree still exists, each thread is shown once. It starts with a summary: threads per state (deleted ones by reason) and per comment store, and the size of the data. `--format json` gives the same to tools. Drafts are never shown: neither those of a review you have not submitted, nor those you deleted before submitting. Ask your agent, e.g. "show me this week's review comments".

## Where your data lives

- **Comments** of a project: `.local-review/` at its root (the git top level, or the open folder), as plain append-only JSON Lines journals. Git ignores it through `.git/info/exclude`. Archiving keeps a thread's journal; only **Delete Old Threads Permanently** (`lr purge`) removes journals.
- **Comments of files outside the open folders**: `~/.local-review/files/`.
- **Retros** of a project: `.local-review/retros/` at its top (one journal per retro, plus your retro preferences).
- **Threads saved from git worktrees**: `.local-review/saved/` of the main repository (one folder per worktree store: its journals as they were, and where they come from).
- **Settings of this machine** (read by the agent hooks, which run outside VS Code): `~/.local-review/config.json`, changed with `lr config` (and by the extension for the retro reminder).
- **Agent sessions**, their subscriptions and message queues: `~/.local-review/sessions/`.

`$LOCAL_REVIEW_HOME` moves `~/.local-review/` elsewhere. Local Review collects no telemetry, and makes no network call, except the optional classification of a retro by Jev when you set up its key.

## Known limitations

- **Channels are a Claude Code research preview**: the launch flag may change, Claude Code warns at each launch, and Team and Enterprise organizations must enable channels (an admin setting). Without the channel, comments wait until you ask Claude.
- **The Claude Code panel of VS Code** cannot be launched with a channel: use Claude Code in a terminal, or ask `/local-review:review` in the panel.
- **Files outside the open folders** have no git features (comments on a diff side, following a rename with git).
- **A rebase in progress**: threads follow the branch being rebased, but commenting during a rebase is not supported yet.
- **Retros** are run by Claude Code for now; the time announced is a rough estimate, to be refined on real retros. They read back only the conversations of replies written since Local Review links them, and only on the machine where they ran, while Claude Code keeps them.
- **Other agents** (e.g. Codex) are planned: the storage, the `lr` command line and the session registry are agent-neutral.

## Contributing

Contributions are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers the development setup, tests and conventions, and [docs/architecture.md](docs/architecture.md) explains how the pieces fit together.

## License

[MIT](LICENSE)

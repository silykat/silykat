# silykat

**A GitHub-style code review between you and your AI coding agent, 100% local.**

Select lines in VS Code, leave comments like on a pull request, and your agent reads them, changes the code and answers in the threads. No pull request, no server, no account: comments live next to your code, and nothing leaves your machine (unless you opt in to an online classifier for your retros).

silykat is agent-agnostic by design; **Claude Code** is the first supported agent.

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
- [Using silykat](#using-silykat)
- [Working with agents](#working-with-agents)
- [Retros](#retros)
- [Settings](#settings)
- [The `slk` command line](#the-slk-command-line)
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
- **Your whole history**: read back every thread of a project, resolved and deleted ones included, across its repositories and worktrees (`slk review history`). It tells a thread you removed from one gone with its branch, and keeps the threads of a git worktree after you remove it, once saved (automatically when your agent removes it). **Archive** finished threads to clear VS Code without losing them, export everything to JSON, or delete old threads for good. Or keep no history at all: deleting then erases.
- **Retros with your agent**: look back at your work with Claude (your review threads, your sessions with it, an audit of its setup: the sources you choose), and decide together what to keep, remove or improve in its setup (`CLAUDE.md`, skills, hooks…); Claude applies what you validate (`/silykat:retro`). The next retro checks whether the changes helped, and the status bar tells you when a retro is due.
- **100% local**: no network calls, no telemetry, plain files you can read. The one exception is opt-in: the classification of a retro by Jev, only if you give it a key.

## Requirements

- **VS Code** 1.100 or later (or an editor based on it: see [Other editors based on VS Code](#other-editors-based-on-vs-code-cursor-vscodium-windsurf)).
- **Node.js** 22.12 or later, with **npm** 11.10 or later, and **git**, to build the extension (it is not on the Marketplace yet).
- For the agent integration: **Claude Code** in a terminal, logged in with a claude.ai account (Pro or Max) or a Console API key. Team and Enterprise organizations must enable channels (see [Known limitations](#known-limitations)).

## Installation

### 1. The VS Code extension

```sh
git clone git@github.com:silykat/silykat.git
cd silykat
npm install
npm run install-ext
```

This builds `packages/vscode-extension/dist/silykat.vsix` and installs it with the `code` command (it must be on your PATH: in VS Code, **Shell Command: Install 'code' command in PATH**). Then reload VS Code (**Developer: Reload Window**).

#### Other editors based on VS Code (Cursor, VSCodium, Windsurf…)

These editors are not tested yet. The editor must be based on VS Code 1.100 or later.

1. Build the extension without installing it:

   ```sh
   npm run package
   ```

2. In the editor, run **Extensions: Install from VSIX…** from the Command Palette, and pick `packages/vscode-extension/dist/silykat.vsix`.
3. Reload the editor (**Developer: Reload Window**).

The Claude Code plugin (next step) does not depend on the editor.

### 2. The Claude Code plugin

```sh
claude plugin marketplace add silykat/silykat
claude plugin install silykat@silykat
```

The repository is private for now: this needs git access to it. To update later:

```sh
claude plugin marketplace update silykat
claude plugin update silykat@silykat
```

### 3. Launch Claude Code with the silykat channel

The channel is what lets your comments reach Claude by themselves. Channels are a Claude Code research preview, so the launch command is long: add an alias, e.g. to `~/.zshrc`:

```sh
alias claude-slk='claude --dangerously-load-development-channels plugin:silykat@silykat'
```

At each launch, Claude Code warns about development channels: choose **I am using this for local development**.

## Quick start

1. Open your project in VS Code, and start `claude-slk` in a terminal, in the same repository (or any worktree of it).
2. Ask Claude to change something. As soon as it modifies a file, it is **subscribed** to that branch and says so.
3. In VS Code, select the lines you want to comment on and press **`Ctrl+Cmd+C`** (`Ctrl+Alt+C` on Windows/Linux), or right-click → **silykat: Comment on Selection**. Type your comment and click **Comment**.
4. Claude receives it within seconds, changes the code and replies in the thread: **✅ Addressed by Claude — please verify**, or **❓ Claude is waiting for your reply**. The first time, Claude asks to use the `silykat:review` skill: allow it for good.
5. Check the change, reply if needed, and **Resolve** the thread (✓ in its header). Only you resolve threads.

## Using silykat

### Comments

- **On lines**: select them, then **`Ctrl+Cmd+C`** or **silykat: Comment on Selection** (editor context menu or command palette).
- **On a whole file**: right-click its tab → **silykat: Comment on File**. The thread has no line and shows at the top of the file.
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

`git worktree remove` deletes the worktree's folder, and its comments with it (they are in its `.silykat/`). The first time a worktree you open has comments, VS Code tells you so. Before removing it, run **silykat: Save Worktree Threads** (or `slk worktree save` in the worktree, or **Save Threads Now** in that message): its threads are copied to the store of the main repository, with the worktree and branch they come from, and stay in the history and in retros after the worktree is gone. Saving again refreshes the copy; nothing is removed from the worktree, and VS Code does not show the copies.

When your agent is about to remove a worktree (`git worktree remove`, `rm -r` of the worktree, or Claude Code's own worktrees left with "remove"), the Claude Code plugin saves its threads first and Claude tells you so. When you do not keep the history ([Keep history](#keep-history)), it does not: Claude warns you instead.

### Archive and clean up

Finished threads can leave VS Code without leaving your history:

- **Archive Thread** (in a thread's header), or **silykat: Archive Resolved Threads…** for every thread resolved before a date (`2026-10-01`, or `30d` for 30 days ago; it says how many first). Archived threads disappear from VS Code and from what your agent sees (`slk review list`), and stay in `slk review history` and in retros.
- **silykat: Show Archived Threads** lists them: pick the ones to bring back.
- **silykat: Export Threads (JSON)…** writes every thread of the open folders, whatever its state, archived ones included, to a JSON file: keep it before a clean-up.
- **silykat: Delete Old Threads Permanently…** deletes for good the **finished** threads (resolved, archived or deleted) where nothing happened since a date (`2026-10-01`, or `90d`: it says "since 2026-07-05 (90 days)"), after a confirmation that says how many. Threads still in progress are kept, however old, and so are those holding a draft reply of your review in progress. Once a project had a retro, the threads the next retro will read are kept too (those active since the last retro, and those of a retro in progress), and the confirmation says how many; without any retro, nothing is kept for one, and it says so. This cannot be undone: they are gone from the history and from retros too.

These act on each open folder as `slk review history` does (its subfolders and the worktrees of its repositories), and on the files outside the open folders. Your agent can do the same for you: ask it to "archive my resolved comments of last month" or to "delete the comments older than 3 months" (it tells you how many and waits for your yes; Claude Code then asks you to allow the deletion itself). An older version of silykat shows an archived thread read-only, and asks to be updated.

### Keep history

By default, silykat keeps the history of what you delete, for `slk review history` and retros: a deleted thread leaves VS Code and what your agent sees, and stays on disk; the agent saves the threads of a git worktree before removing it. Turn **`silykat.keepHistory`** off (in your user settings, or `slk config set keep-history off`) if you do not want that, e.g. if you do not run retros: deleting a thread then **erases** it for good (with its copies saved from worktrees), and nothing is saved when an agent removes a worktree (you can still save one yourself with **Save Worktree Threads**). When you turn it off in VS Code, it offers to erase the history already kept in your folders (deleted threads, and threads saved from worktrees); with `slk`, run `slk review purge --history` to see it, then `slk review purge --history --yes`. Your retros then say that they do not see deleted threads. The setting is for the whole machine: VS Code writes it to the settings of the machine, which `slk` and the agent read.

### Files outside the open folders

A file in none of the folders open in VS Code (e.g. a spec your agent wrote in a parent folder) can be commented like any other. Its threads are kept on your machine, with the file's full path, and show in any VS Code window where you open it.

## Working with agents

### What the agent does

When a comment reaches Claude, it follows the `silykat:review` skill: it reads the threads waiting for it with their current code, then for each one either applies the request and replies **addressed**, or asks one precise question (**needs-info**) without touching the code, or explains a disagreement. It ends with a short summary. You can also ask for it at any time: **`/silykat:review`**.

Each reply keeps the link to the conversation it was written in: the id of the Claude Code session, and of the step that wrote it. `slk review history` shows it (resume that conversation with `claude --resume <session id>`, from the folder it ran in), and a retro reads it back to understand an ambiguous thread.

### Sessions and subscriptions

Every Claude Code session started with the plugin registers itself; VS Code shows the sessions of your workspace in the status bar, each with its short id (e.g. **Claude a1b2c3d4**). **silykat: Show Agent Sessions** lists them all, with what each one is subscribed to.

A comment goes to **every session subscribed** to its git branch (or, outside git, to its file or folder). A session subscribes:

- when it is **started in a git worktree** (to its branch);
- when it **modifies a file** (to that file's branch; outside git, to the file), with its editing tools or a shell command;
- when **you ask it**: "subscribe to this branch", "subscribe to this folder", "unsubscribe", "what are you subscribed to?" (or `/silykat:subscribe`, `/silykat:unsubscribe`).

Reading files or moving to a folder does not subscribe. Claude tells you whenever a subscription changes. Two sessions on one branch (e.g. a developer and a reviewer) both get its comments: what each one does with them is up to it.

When **nobody is subscribed** to what you publish, VS Code asks first: cancel, publish anyway (saved, sent to nobody: an agent reads it when you ask), or publish without being asked again for that folder until VS Code closes.

### Editing or deleting while the agent works

Editing or deleting a published comment tells the subscribed sessions too. Claude Code hands the change to Claude between two of its steps: it adapts its work to the new version, or, for a deleted thread, stops working on it and asks you before undoing anything. A thread the agent had addressed goes back to it, and the comment shows **edited after Claude replied**. The agent can never answer an outdated version: `slk` refuses a reply to a thread that changed since the agent read it.

### Without the channel

A session started without the channel (plain `claude`, or the Claude Code panel of VS Code) still receives the comments, but only sees them when you ask it (`/silykat:review`). VS Code tells you once, with the command to relaunch it, and marks the session with ⚠ in the status bar. To send nothing to the sessions at all, turn off `silykat.pushToAgents`.

## Retros

A retro is a look back at your work with your agent since the last retro (the review feedback you gave it, your sessions with it, its setup), to improve its setup from what really happened, like a sprint retro with your agent. It is a discussion: nothing changes without your say-so, and what you validate, Claude applies.

### Running a retro

In a Claude Code session started in your working folder (the **project**: that folder, its subfolders, every repository in it and their git worktrees), run **`/silykat:retro`**, or ask for a retro. Then:

1. **The last retro** (from the second one on): Claude recalls what was decided then (whether it helped is measured from your feedback, not asked), and asks whether you want to change anything in the retro itself (what it looks at, its level of detail, subjects to ignore…). Your wishes become the **retro preferences** of the project, applied from now on.
2. **The scope**: the comment stores found, then the period, which you choose at every retro: since the last retro (for a first one, the last 7 days), the last 30 days, or everything, or a date of your own. Each choice shows its own figures: threads, Claude Code sessions, the reports to write on them with their estimated time and cost (when the retro reads your sessions through reports), those already written, and whether it reads again the threads of the last retro.
3. **The sources** of the retro, for that period: your **reviews** (the review threads), your **sessions** with Claude, and the **audit of your setup**. A retro reads one or more, as you choose: with or without reviews, with or without sessions. Each source has a setting: **yes** (always read), **no** (never) or **ask** (asked at each retro). The settings of the project come first (its `.silykat/config.json`, yours only), then those of the machine (**Retro Sources** in VS Code, or `slk config`), else **ask**. At the first retro of a project, Claude asks how you want each source for it, and saves your answers for its next retros (change them with `slk config set retro-source-audit no --project`, for instance). Then, for the sources set to **ask**, it asks whether to include them: the reviews and the sessions only when the period has some (with their numbers), the audit always (about 8 minutes). Last, a **recap** says what will run and why (a setting, your answer, or nothing in the period: "Reviews: none in this period"), with the estimated time: start, or leave a source out. With no source left, there is nothing to look back at, and no retro is started.
4. **The audit of your setup**, alongside (when the retro includes it): Claude Code's own `/doctor prompt-audit` (2.1.283 or later), run in a separate, read-only Claude Code (no shell, no edit), looks for stale, contradictory or duplicated rules in your `CLAUDE.md` files, skills, agents and commands, the project's and `~/.claude`'s. It uses Opus and takes a few minutes (about 4 minutes and $1.70 at API prices with Sonnet, on a project with a few rules files and a large `~/.claude`; more with Opus).
5. **Your sessions**, alongside (when the retro includes them), read in one of two ways, never both (they would tell the same sessions twice): the setting **Retro Sessions** (`silykat.retroSessions`, or `slk config set retro-sessions`) chooses, for the whole machine, and a retro keeps the way set when it started.
   - **`reports`** (the default, finer): **a report on each of your sessions**. Every Claude Code session of the project and of the period where you typed at least one prompt (but the retro's own, and those run by a program with `claude -p`, such as the audits of earlier retros) is read by Opus, in a separate Claude Code each, 4 at once, the longest first (so that the last one does not hold the retro up). First, silykat computes without a model the **signals** of the session and of its sub-agents: corrections, interruptions and refusals, your edits of Claude's work, Claude's questions, permission blocks, tool errors and commands that fail again and again, hooks, skills and sub-agents used (and skills never used), compactions, the prompts you typed, commits and pull requests. Each signal points at a moment of the conversation. Then the model reads the conversation around those moments only (secrets masked; it can read nothing else and change nothing) and writes the **report**: what you wanted and how it went, the signals that reveal something to improve, the patterns and rituals that recur, observations on your setup and leads. Every moment it cites is checked against the session's records. Reports are kept in `.silykat/retros/sessions/`: the next retro reuses them, and writes a new one only for a session that went on since. With Opus, a report took about a minute and a half and $0.40 at API prices on a session of 9 prompts; longer sessions take more, and the scope gives the estimate for yours. A report may take 20 minutes at most: a session whose report would take longer (roughly 180 prompts and more) is **left out** of the retro, before anything is spent, and the choice of the period says so with ⚠️, with what tells it apart (its dates, prompts, estimated time, tokens, size, compactions); when it has a report already, written while it was shorter, that report is read instead. The **Keep history** setting does not touch the reports.
   - **`insights`** (cheaper, less precise): the retro runs Claude Code's `/insights` in a separate Claude Code (about a minute; its tokens count against your plan like a session's). `/insights` keeps, for each session of the machine, facts counted without a model (messages, interruptions, tool errors…) and, for the longer ones, a summary written by a model (goal, outcome, frictions such as a wrong approach or a misunderstood request). The retro keeps only the sessions **of the project and of the period**, the retro's own and those run by a program (`claude -p`) left out: its report, which covers every project of the machine, is never read. If `/insights` fails, the retro goes on without your sessions; if its format can no longer be read, Claude asks you to report it as a bug.

   The end of the retro says what it took (an equivalent at the API list price: on a subscription, tokens counted against your usage limits, not a bill).

6. **How much your tools are used** (with the audit): silykat counts, without a model, how many times each skill, command and sub-agent of your setup was used, by you or by Claude: the project's on the project's sessions, yours (`~/.claude`) on every project. It only sees this machine, and the sessions Claude Code still keeps (30 days by default).
7. **The analysis**, in sub-agents with a fresh context, so that the session keeps its own for the discussion. One **classifies** the threads (Jev with a key, else Haiku), when the retro includes the reviews. Then **each source included is read by its own sub-agent** (Opus, for the most careful reasoning), at the same time: the **threads**, all together (grouped by cause, with the check of last time's changes); your **sessions** (what recurs from one to the next, and the strong leads of a single one); the **audit**, with the usage of your tools. Each records its findings in one common format (the cause, the evidence, the change it suggests, its confidence), checked by program. Last, the **analysis weighs them against each other**, with your setup (rules files, skills, commands, sub-agents, hooks of the project and of `~/.claude`), the statistics and the previous retros: a lead seen in one source and confirmed by another gains weight; when two sources seem to disagree, it goes back to the source (the thread, the moment of the session, the code or the setup file) and settles it, without asking you. When a thread is ambiguous (why did Claude do that?), the conversation where Claude replied is read back: the request, the files read, the commands and edits, the skill in use. Claude Code deletes its conversations after 30 days by default (the `cleanupPeriodDays` setting): an older one is no longer available, and the retro says so and does without it.
8. **Did last time's changes help?** (from the second retro on): for each change you adopted at the last retro, the analysis names, in the new period, the threads with the same cause and the sessions that show it again, and `slk` computes the numbers, source by source, on the sources the change rested on: the threads on its subject out of all the threads, the sessions out of all the sessions, before and since. The feedback **stopped** or **decreased**: the change is kept. It **did not decrease** (on any of its sources): the retro proposes to revise it (reword the rule, move it up, make it a hook, or remove it). When none of its sources has data in the new period (left out of this retro, or nothing in it), or the change came from the audit alone, it is **not measured**, and the retro says so.
9. **The proposals**, in three columns, **To keep**, **To remove** and **To improve**. Each cites its threads and its sessions (with words of the session's summary or report, and the moments of the conversation it points at); one that rests on your sessions only says so, since a summary written by a model is not your own words. A problem seen in several sources is raised once. Leads seen in a single thread or session, and confirmed nowhere else, are kept **to watch**. When the audit flags a skill, command or sub-agent **that nobody used**, the retro does not propose to fix it: it asks whether to **remove it**, **keep it and fix it**, or **keep it as is**, and says what the count rests on and its limits (this machine only: a tool shared in the repository may serve your team; sessions older than 30 days are gone). Before the proposals, Claude shows **what recurs across your sessions** (patterns, frictions, rituals), for you to find leads of your own, such as tasks to automate: it is recorded with the retro, and `slk retro show` shows it again.
10. **The discussion**, one proposal at a time (those that revise a change of the last retro first), each in its own message and always in the same parts: its source (the threads and sessions, with an excerpt, or the audit's finding), its numbers (threads, reopened, questions, back-and-forth), the file and the existing rule, why, the target and the confidence; then **the exact change**: a diff of the file, or the whole content of a new file, also shown next to each choice of the question. Accept, modify, exclude, or change its target: **project, shared** (the repository's `CLAUDE.md` or `.claude/`, for the team), **project, personal** (`CLAUDE.local.md`, yours only) or **you, everywhere** (`~/.claude/`). A modified change is shown again before anything is written. You can also just talk it through.
11. **Each change is applied** as soon as you validate it, exactly as you read it, by a sub-agent in the background: the discussion goes on meanwhile. The retro ends with the list of files changed.

Guard rails are checked by program (in `slk`, whatever the agent): a proposal needs at least 2 pieces of evidence, threads or sessions (or a finding of the audit, to remove or rewrite a rule); a session it cites must be one of the retro's, quoted word for word from its summary or report, at moments its report cites; a rule you had to enforce during the period is never proposed as "keep"; one subject per proposal; the target is asked when nothing in your threads tells it; a subject you excluded comes back only if new feedback raises it; every change adopted at the last retro is checked on the sources it rested on, and one that did not reduce the feedback (with 2 threads or sessions or more) gets a proposal to revise it; a finding of the audit on a tool nobody used becomes the question "keep it or remove it?". The findings of each source are checked the same way (one cause each, evidence of their own source, quoted word for word).

Each retro is recorded in `.silykat/retros/` at the top of the project (or of its repository): the period, the sources read, the threads and sessions read, the proposals, your decisions, exclusions and preferences. The next retro starts from it. `slk retro list` and `slk retro show <id>` read them back.

### When to run a retro

A retro is worth it about once a week: with too little feedback there is not much to learn, with too much the analysis reads it less finely. silykat keeps count of the **days** since the last retro, the **size** of the review threads since then (the threads it would read) and your **sessions** with Claude in the project, and reminds you:

- in the **status bar** of VS Code, e.g. `Retro: 6 d · 640.0 KB`, which becomes `Retro due: 8 d · 1.2 MB` once a retro is due; click it to see how to run one (and copy `/silykat:retro`). It is hidden while there is nothing new since the last retro;
- in **Claude's first reply** of a new session started in the project, once: Claude tells you a retro is due and suggests `/silykat:retro` (it does not start it on its own).

A retro is due after **7 days**, or sooner once the threads weigh **1 MB**, and never later than **25 days**, so that the retro can still read back the conversations linked to replies (Claude Code deletes them after 30 days by default). The count starts after the last retro of the folder, or of a folder above it (a retro covers the subfolders), in this git worktree or another one of the same repository; before any retro, it starts at the first thread or session. The sessions are those Claude Code still keeps when this version of silykat first runs, then each new one (counted when it starts); sessions run by a program (`claude -p`) do not count. Change these thresholds in the settings below; `slk retro cadence` tells where things stand.

### The Jev key (optional)

[Jev](https://jevtypesafeai.com/) classifies the threads faster and cheaper than a model of your subscription; without a key, Haiku does it. At your first retro, Claude offers to set it up: it proposes `~/.config/silykat/jev-key` and gives you a command to run **in your own terminal**, which asks for the key without showing it and saves it in a file only you can read. The key never goes through the conversation, and is never written in a journal or an output. Claude then checks, without reading it, that the file is readable by you only and is in no repository (`slk retro key`). `JEV_API_KEY` works too. This classification is the only network call of silykat, made only during a retro, and only with a key.

## Settings

| Setting                              | Default      | Description                                                                                                                                 |
| ------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `silykat.userName`                   | _(empty)_    | Name shown on your comments. Empty: `git config user.name`, else your OS user name.                                                         |
| `silykat.commentShortcut`            | `ctrl+cmd+c` | Shortcut of **Comment on Selection**: `ctrl+cmd+c`, `ctrl+alt+c`, `cmd+alt+m` or `none` (then bind `silykat.commentSelection` yourself).    |
| `silykat.notifyOnAgentReply`         | `true`       | Notify when the agent replies. The status bar counter of threads waiting for your reply is always shown.                                    |
| `silykat.excludeFromGit`             | `true`       | Add `.silykat/` to `.git/info/exclude` on the first comment. Never touches `.gitignore`.                                                    |
| `silykat.pushToAgents`               | `true`       | Send what you publish to the subscribed agent sessions. Off: nothing is sent, and no session warnings are shown.                            |
| `silykat.keepHistory`                | `true`       | Keep deleted threads (for `slk review history` and retros) and save a worktree's threads before an agent removes it. Off: deleting erases.  |
| `silykat.retroSessions`              | `reports`    | How a retro reads your sessions with the agent: `reports` (a report on each one, finer) or `insights` (Claude Code's `/insights`, cheaper). |
| `silykat.retroSources.reviews`       | `ask`        | Whether a retro reads your review threads: `yes` (always), `no` (never) or `ask` (at each retro). A project's own setting comes first.      |
| `silykat.retroSources.sessions`      | `ask`        | The same for your sessions with the agent.                                                                                                  |
| `silykat.retroSources.audit`         | `ask`        | The same for the audit of your setup (`/doctor prompt-audit`, about 8 minutes).                                                             |
| `silykat.retroReminder.days`         | `7`          | A retro is due this many days after the last one.                                                                                           |
| `silykat.retroReminder.sizeKB`       | `1000`       | Or sooner, once the review threads since the last retro weigh this many KB (1000 = 1 MB).                                                   |
| `silykat.retroReminder.maxDays`      | `25`         | And never later than this many days, whatever `days` says.                                                                                  |
| `silykat.retroReminder.statusBar`    | `always`     | The retro reminder in the status bar: `always`, `whenDue` or `never`.                                                                       |
| `silykat.retroReminder.agentMessage` | `true`       | When a retro is due, Claude says so once at the start of a session.                                                                         |

The agent's reminder runs outside VS Code: when you change a `retroReminder` setting in your user settings, the extension also writes it to the settings of the machine (`slk config`), which the agent reads. Without VS Code, set them with `slk config set retro-reminder-days 10` (and `retro-reminder-size`, `retro-reminder-max-days`, `retro-reminder on|off`). A value set in VS Code wins over one set with `slk config`. **Retro Sessions** and **Retro Sources** are written to the settings of the machine the same way (`slk config set retro-sessions reports|insights`, `slk config set retro-source-reviews yes|no|ask`…). The settings of a project (asked at its first retro) come before them: `slk config --project` shows them, `slk config set retro-source-audit no --project` changes one.

## The `slk` command line

Agents read and answer the threads with `slk`, an agent-neutral command line; the Claude Code plugin puts it on Claude's `PATH`. You rarely need it yourself, but it is handy to see what the agent sees:

| Command                                                                   | What it does                                                                               |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `slk review status`                                                       | How many threads wait for the agent, and for you                                           |
| `slk review list [--all] [--thread <id>]…`                                | The threads waiting for the agent, with their current code                                 |
| `slk review show <thread-id>`                                             | One thread in full                                                                         |
| `slk review reply <thread-id> --agent <name> --rev <v> --body -`          | Reply (body on stdin), optionally `--status addressed\|needs-info`                         |
| `slk subscribe [<folder>] [--path]`, `slk unsubscribe`                    | Subscribe the session `slk` runs in to a branch or a path, or stop                         |
| `slk subscriptions`, `slk sessions`                                       | What this session is subscribed to; the running sessions                                   |
| `slk review history [--since <date>] [--out <file>]`                      | Every thread of the project, whatever its state, in full (export)                          |
| `slk review archive <id>…`, `slk review archive --resolved-before <date>` | Archive threads (`--list`: the archived ones); `slk review unarchive <id>…`                |
| `slk review purge --before <date> [--yes]`                                | Delete old finished threads for good (without `--yes`: only says which)                    |
| `slk review purge --history [--yes]`                                      | Erase the history kept: deleted threads, threads saved from worktrees                      |
| `slk worktree save [<folder>]`                                            | Save a git worktree's threads before removing the worktree                                 |
| `slk config`, `slk config set <name> <value>`                             | The settings of this machine (`keep-history`, retro reminder, `retro-sessions`, sources)   |
| `slk config --project`, `slk retro sources`                               | The settings of the project (the sources of its retros), before the machine's              |
| `slk retro scope`, `slk retro show <id>`, `slk retro list`                | What a retro would cover; a retro and its proposals (`--next`: one at a time); past retros |
| `slk retro cadence`                                                       | Is a retro due? Days, size of the threads and sessions since the last retro                |

Add `--root <folder>` to target a project from elsewhere (`--root /` for files outside the open folders), and `--format json` for tools. `slk --help` has the full reference.

### The history of your comments

`slk review history` reads back **every thread of a project**, whatever its state: open, addressed, resolved or deleted, archived or not, each with its whole conversation (comments, status changes, dates, comments deleted since), its branch, its file and the commented code. The project is the current folder (or `--root <folder>`), its subfolders, and the git worktrees of the repositories it contains, even when they are kept next to it: run it from the parent folder of several repositories to get them all. `--since 2026-10-01` (or `--since 7d`) keeps the threads active since that date. Each agent reply shows the session it was written in (and the step, when known). Deleted threads say why: **removed by you**, or **gone with their branch** (threads deleted before silykat recorded it say "reason unknown"). Threads saved from a worktree are listed under **saved from a worktree**, with their worktree and the day they were saved; while the worktree still exists, each thread is shown once. It starts with a summary: threads per state (deleted ones by reason) and per comment store, and the size of the data. `--format json` gives the same to tools. Drafts are never shown: neither those of a review you have not submitted, nor those you deleted before submitting. Ask your agent, e.g. "show me this week's review comments".

## Where your data lives

- **Comments** of a project: `.silykat/` at its root (the git top level, or the open folder), as plain append-only JSON Lines journals. Git ignores it through `.git/info/exclude`. Archiving and deleting keep a thread's journal; only **Delete Old Threads Permanently** (`slk review purge`), and deleting with [Keep history](#keep-history) off, remove journals.
- **Comments of files outside the open folders**: `~/.silykat/files/`.
- **Retros** of a project: `.silykat/retros/` at its top (one journal per retro, plus your retro preferences), and its own settings in `.silykat/config.json`.
- **Threads saved from git worktrees**: `.silykat/saved/` of the main repository (one folder per worktree store: its journals as they were, and where they come from).
- **Settings of this machine** (read by the agent hooks, which run outside VS Code): `~/.silykat/config.json`, changed with `slk config` (and by the extension for Keep history and the retro settings).
- **Agent sessions seen** (for the retro reminder): `~/.silykat/agent-sessions.jsonl`, the folder and start of each session.
- **Agent sessions**, their subscriptions and message queues: `~/.silykat/sessions/`.

`$SILYKAT_HOME` moves `~/.silykat/` elsewhere. silykat collects no telemetry, and makes no network call, except the optional classification of a retro by Jev when you set up its key.

## Known limitations

- **Channels are a Claude Code research preview**: the launch flag may change, Claude Code warns at each launch, and Team and Enterprise organizations must enable channels (an admin setting). Without the channel, comments wait until you ask Claude.
- **The Claude Code panel of VS Code** cannot be launched with a channel: use Claude Code in a terminal, or ask `/silykat:review` in the panel.
- **Files outside the open folders** have no git features (comments on a diff side, following a rename with git).
- **A rebase in progress**: threads follow the branch being rebased, but commenting during a rebase is not supported yet.
- **Retros** are run by Claude Code for now; the time announced is a rough estimate, to be refined on real retros. They read back only the conversations of replies written since silykat links them, and only on the machine where they ran, while Claude Code keeps them.
- **Other agents** (e.g. Codex) are planned: the storage, the `slk` command line and the session registry are agent-neutral.

## Contributing

Contributions are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers the development setup, tests and conventions, and [docs/architecture.md](docs/architecture.md) explains how the pieces fit together.

## License

[MIT](LICENSE)

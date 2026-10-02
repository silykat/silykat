# Local Review

**A GitHub-style code review between you and your AI coding agent, 100% local.**

Select lines in VS Code, leave comments like on a pull request, and your agent reads them, changes the code and answers in the threads. No pull request, no server, no account: comments live next to your code, and nothing ever leaves your machine.

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
- **Your whole history**: read back every thread of a project, resolved and deleted ones included, across its repositories and worktrees (`lr history`).
- **100% local**: no network calls, no telemetry, plain files you can read.

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

A thread belongs to the branch of its file. After `git checkout`, VS Code shows only the threads of the branch checked out; the others come back with their branch. Each worktree has its own branch, and there is **one review per branch** (one per folder for files not tracked by git, see [Review mode](#review-mode)): the status bar and **Submit Review** act on the review of the file you have open. Renaming a branch keeps its threads; deleting it deletes them. Files ignored by git, and files outside git, are on no branch: their threads always show.

### Files outside the open folders

A file in none of the folders open in VS Code (e.g. a spec your agent wrote in a parent folder) can be commented like any other. Its threads are kept on your machine, with the file's full path, and show in any VS Code window where you open it.

## Working with agents

### What the agent does

When a comment reaches Claude, it follows the `local-review:review` skill: it reads the threads waiting for it with their current code, then for each one either applies the request and replies **addressed**, or asks one precise question (**needs-info**) without touching the code, or explains a disagreement. It ends with a short summary. You can also ask for it at any time: **`/local-review:review`**.

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

## Settings

| Setting                          | Default      | Description                                                                                                                                  |
| -------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `localReview.userName`           | _(empty)_    | Name shown on your comments. Empty: `git config user.name`, else your OS user name.                                                          |
| `localReview.commentShortcut`    | `ctrl+cmd+c` | Shortcut of **Comment on Selection**: `ctrl+cmd+c`, `ctrl+alt+c`, `cmd+alt+m` or `none` (then bind `localReview.commentSelection` yourself). |
| `localReview.notifyOnAgentReply` | `true`       | Notify when the agent replies. The status bar counter of threads waiting for your reply is always shown.                                     |
| `localReview.excludeFromGit`     | `true`       | Add `.local-review/` to `.git/info/exclude` on the first comment. Never touches `.gitignore`.                                                |
| `localReview.pushToAgents`       | `true`       | Send what you publish to the subscribed agent sessions. Off: nothing is sent, and no session warnings are shown.                             |

## The `lr` command line

Agents read and answer the threads with `lr`, an agent-neutral command line; the Claude Code plugin puts it on Claude's `PATH`. You rarely need it yourself, but it is handy to see what the agent sees:

| Command                                                  | What it does                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| `lr status`                                              | How many threads wait for the agent, and for you                   |
| `lr list [--all] [--thread <id>]…`                       | The threads waiting for the agent, with their current code         |
| `lr show <thread-id>`                                    | One thread in full                                                 |
| `lr reply <thread-id> --agent <name> --rev <v> --body -` | Reply (body on stdin), optionally `--status addressed\|needs-info` |
| `lr subscribe [<folder>] [--path]`, `lr unsubscribe`     | Subscribe the session `lr` runs in to a branch or a path, or stop  |
| `lr subscriptions`, `lr sessions`                        | What this session is subscribed to; the running sessions           |
| `lr history [--since <date>]`                            | Every thread of the project, whatever its state, in full           |

Add `--root <folder>` to target a project from elsewhere (`--root /` for files outside the open folders), and `--format json` for tools. `lr --help` has the full reference.

### The history of your comments

`lr history` reads back **every thread of a project**, whatever its state: open, addressed, resolved or deleted, each with its whole conversation (comments, status changes, dates, comments deleted since), its branch, its file and the commented code. The project is the current folder (or `--root <folder>`), its subfolders, and the git worktrees of the repositories it contains, even when they are kept next to it: run it from the parent folder of several repositories to get them all. `--since 2026-10-01` (or `--since 7d`) keeps the threads active since that date. It starts with a summary: threads per state and per comment store, and the size of the data. `--format json` gives the same to tools. Drafts of a review you have not submitted are not shown. Ask your agent, e.g. "show me this week's review comments".

## Where your data lives

- **Comments** of a project: `.local-review/` at its root (the git top level, or the open folder), as plain append-only JSON Lines journals. Git ignores it through `.git/info/exclude`.
- **Comments of files outside the open folders**: `~/.local-review/files/`.
- **Agent sessions**, their subscriptions and message queues: `~/.local-review/sessions/`.

`$LOCAL_REVIEW_HOME` moves `~/.local-review/` elsewhere. Local Review makes no network call and collects no telemetry.

## Known limitations

- **Channels are a Claude Code research preview**: the launch flag may change, Claude Code warns at each launch, and Team and Enterprise organizations must enable channels (an admin setting). Without the channel, comments wait until you ask Claude.
- **The Claude Code panel of VS Code** cannot be launched with a channel: use Claude Code in a terminal, or ask `/local-review:review` in the panel.
- **Files outside the open folders** have no git features (comments on a diff side, following a rename with git).
- **A rebase in progress**: threads follow the branch being rebased, but commenting during a rebase is not supported yet.
- **Other agents** (e.g. Codex) are planned: the storage, the `lr` command line and the session registry are agent-neutral.

## Contributing

Contributions are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers the development setup, tests and conventions, and [docs/architecture.md](docs/architecture.md) explains how the pieces fit together.

## License

[MIT](LICENSE)

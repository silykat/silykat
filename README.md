# local-review

Skills & VSCode extension for local code review.

A GitHub-style code review between you and your AI coding agent, running 100% locally. It is LLM-agnostic: Claude Code is the first supported agent.

- **VS Code extension** (`packages/vscode-extension`): select lines in a file or a diff and comment on them, either as a direct comment or as part of a review.
- **Agent integration** (coming soon): the agent reads the comments, updates the code and replies in the threads. It starts with a Claude Code skill, built on an agent-neutral CLI.

Comments are stored in `.local-review/` at the root of the reviewed project. That folder is automatically excluded from git through `.git/info/exclude`. No data ever leaves your machine.

## Usage

Select lines, then use **Local Review: Comment on Selection** from the editor context menu, or press **`Ctrl+Cmd+C`** (`Ctrl+Alt+C` on Windows/Linux).

To comment on a whole file rather than on lines, right-click its tab → **Comment on File** (or the command palette): the thread has no line, shows at the top of the file, and works like any other thread.

The shortcut can be changed in `settings.json`:

```jsonc
"localReview.commentShortcut": "ctrl+cmd+c" // or "ctrl+alt+c", "cmd+alt+m", "none"
```

For any other key combination, set it to `"none"` and bind the `localReview.commentSelection` command in `keybindings.json`.

The agent's replies appear live in the thread, signed with the agent's name, with a status label: **Waiting for Claude**, **💬 Claude replied**, **❓ Claude is waiting for your reply** or **✅ Addressed by Claude — please verify**. Until an agent is plugged in, the default agent name is Claude.

When the agent replies, a notification says where (**Open** takes you there); replies arriving together are announced once. The status bar counts the threads waiting for your reply (the agent spoke last and they are not resolved); click it to see them. Notifications can be turned off with `localReview.notifyOnAgentReply`.

Reply in the thread with **Reply** (or `Cmd+Enter`). Replying to a question, or to a thread the agent marked as addressed, hands the thread back to the agent: it shows **Waiting for Claude** again.

Only you can close a thread: **Resolve** (✓ in the thread header) marks it resolved and collapses it, and **Reopen** hands it back to the agent. The Comments panel can filter resolved threads out. Replying in a resolved thread reopens it.

You can **Edit** or **Delete** your own comments (the agent's are read-only), and **Delete Thread** from its header. Deleting asks for confirmation; deleting the last comment deletes the thread. Deleted threads disappear from VS Code, but the history stays in the journal.

Threads follow the code: when lines are added or removed above a thread, or inside it, the thread moves with them. The new position is recorded when you save the file, and dropped if you close it without saving. When the file changes outside the editor (another tool, `git stash`, or while VS Code was closed), the thread finds its code again.

When a thread's code disappears (rewritten or deleted elsewhere, stashed away, or the file is gone), the thread is marked **⚠️ Outdated**, like on GitHub: it moves to line 1 instead of staying on lines that are not its code, and quotes the original code. You can still reply, resolve or delete it. Whitespace-only changes (re-indentation, spacing) do not make a thread outdated, and it attaches again by itself if its code comes back (e.g. `git stash pop`).

**Diffs.** You can also comment in the diff of your changes (click a changed file in Source Control), on both sides: the new code (a thread on the file itself) or the old one, including deleted lines. For staged changes, the left side is `HEAD` and the right side is the index. A thread on an older version says which one in its header (**Index**, **HEAD a92bf1e**), and a thread on `HEAD` stays pinned to that exact commit when `HEAD` moves. The same works in the diff of a past commit, opened from the **Timeline**. And in a comparison of two files (Explorer → **Select for Compare**, then **Compare with Selected**): each thread lives on its own file. A thread made in a diff has **Open Original Diff** (in its header) to reopen that exact diff later, even after more commits; if a commit no longer exists (e.g. after a rebase), it says so.

**Review mode.** Instead of **Comment**, click **Start Review**: the comment is saved as a **Pending** draft, and the status bar shows **Review · N**. While the review is in progress, **Add to Review** adds more drafts, and **Comment Now** still publishes right away. Click the status bar to **Submit Review**, with an optional summary, or to **Show Pending Comments**. During a review, replying in a published thread offers **Add to Review** (a draft reply, published with the review; it then hands the thread back to the agent) and **Reply Now**. **Discard Review** deletes all drafts after confirmation: threads that only held drafts disappear, published threads are kept. Drafts survive a restart, and the agent does not see them until the review is submitted.

**Threads belong to their git branch.** A thread remembers the branch of its file (a new file not added to git yet included). Switch branches (`git checkout`) and VS Code shows only the threads of the branch checked out; the others come back with their branch. Each git worktree has its own branch, even one inside another open folder. There is one review per branch, submitted apart: the status bar and **Submit Review** act on the review of the branch of the file you have open. Rename a branch and its threads and review follow it; delete it and they are deleted too. Files ignored by git, and files outside git, are not on a branch: their threads always show.

**Files outside the open folders.** A file in none of the folders open in VS Code (e.g. a spec an agent wrote in a parent folder) can be commented too. Its threads are kept in the machine store, `~/.local-review/files/` (or `$LOCAL_REVIEW_HOME/files/`), with the file's full path, and show in any VS Code window where the file is opened. Agents read them with `--root /`. For now these files have no git features (comments on a diff side, following a rename with git).

Until the first agent integration ships, **Local Review (dev): Simulate Agent Reply** writes a reply as the agent from a separate process, through the same path a real integration will use.

## Agent integration (Claude Code)

Agents read and answer the threads with **`lr`**, an agent-neutral command line (`packages/cli`). The Claude Code plugin (`adapters/claude-code/plugin`) ships `lr` and a skill that tells Claude how to handle a review.

Install it once, from this repository's plugin marketplace:

```sh
claude plugin marketplace add lbenamer/local-review
claude plugin install local-review@local-review
```

The repository is private for now: this needs git access to it. To get a newer version later, run `claude plugin marketplace update local-review`, then update the plugin from `/plugin`.

Then, in any session, run **`/local-review:review`** (or ask Claude to handle your review comments). Claude reads the threads waiting for it, changes the code, and replies in each thread: **addressed** when done, **needs-info** when it asks you a question. Its replies show up live in VS Code. Only you resolve threads.

**Sessions register themselves.** Every Claude session started with the plugin registers with Local Review (hooks at session start and end), with its folder and git branch, and records the files it writes. VS Code shows the sessions of your workspace in the status bar (**Claude · feature-x**), and **Local Review: Show Agent Sessions** lists every running session. A session that ends or crashes disappears within seconds. The registry lives in `~/.local-review/sessions/` (or `$LOCAL_REVIEW_HOME`).

**Publishing is enough.** Launch Claude Code with the plugin's **channel** on, and every comment you publish in VS Code (a direct comment, a reply, a submitted review) goes to the session working on that folder by itself: Claude starts on it within seconds when it waits for you, or right after its current turn when it is busy. Comments published close together arrive as one message. Channels are a Claude Code research preview, so for now the launch command is:

```sh
claude --dangerously-load-development-channels plugin:local-review@local-review
```

An alias saves typing it, e.g. in `~/.zshrc`: `alias claude-lr='claude --dangerously-load-development-channels plugin:local-review@local-review'`. Claude Code then shows a warning about development channels at each launch: pick **I am using this for local development**. The first time Claude handles comments on its own, it asks to use the `local-review:review` skill: allow it for good.

This works with Claude Code in a terminal (the `claude` command line). The Claude Code panel of VS Code cannot be launched with a channel yet: there, ask Claude with `/local-review:review` when you have published.

**Comments go to the sessions subscribed to them.** Local Review publishes each comment to the agent sessions **subscribed** to its git branch (or, outside git, to its file or folder), and to all of them: e.g. a developer session and a reviewer session. A session subscribes by itself when it is started in a git worktree, and when it modifies a file (with its editing tools or a shell command: the branch of that file); Claude then tells you. You can also ask it: "subscribe to this branch", "unsubscribe", "what are you subscribed to?" (`/local-review:subscribe`, `/local-review:unsubscribe`). Reading files or moving to a folder does not subscribe. VS Code shows each session with its short id and what it is subscribed to. When nobody is subscribed to what you publish, VS Code warns you: cancel, or publish anyway (the comments are saved, and an agent reads them when you ask it), optionally without being warned again for that folder until VS Code closes.

**Editing or deleting a published comment** tells the subscribed sessions too, and a thread the agent had addressed goes back to it (the comment shows **edited after Claude replied**). While the agent is working, such a change reaches it **between two of its steps** (Claude Code hands it over as soon as the current action finishes): it then adapts its work, or, for a deleted thread, stops working on it and asks you before undoing anything. It can never answer an outdated version: it passes the version it read when it replies (`lr reply --rev`), and `lr` refuses the reply if the thread changed since. Set `localReview.pushToAgents` to `false` to send nothing to the sessions at all (you then ask the agent yourself, e.g. `/local-review:review`).

A session launched without the channel still receives the comments, but only sees them when you ask it (`/local-review:review`). VS Code tells you so once, with the command to relaunch it, and marks the session with a warning sign in the status bar. Deliveries go to each session's inbox, next to its registry entry.

`lr` on its own:

```sh
lr status                                    # how many threads wait for the agent
lr list                                      # those threads, with their current code
lr reply <thread-id> --agent Claude --status addressed --body -   # body on stdin
lr set-status <thread-id> needs-info --agent Claude
lr subscribe [<folder>] [--path]             # subscribe the session lr runs in (found from its processes)
lr subscriptions                             # what it is subscribed to
```

## Architecture

| Folder                      | Purpose                                                                                                                                                                                                                                                                | May depend on |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `packages/core`             | Data model, journals, stores, re-anchoring                                                                                                                                                                                                                             | nothing       |
| `packages/cli`              | `lr`, the entry point for every agent                                                                                                                                                                                                                                  | `core`        |
| `packages/vscode-extension` | The VS Code extension                                                                                                                                                                                                                                                  | `core`        |
| `adapters/claude-code`      | Everything specific to Claude Code: the plugin (manifest, skill, hooks, channel) and the sources of its hooks and channel server; its bundles (`plugin/bin/lr`, `plugin/hooks/local-review-hook.js`, `plugin/channel/local-review-channel.js`) are built and committed | `core`, `cli` |

Neutral packages never depend on an adapter. `npm test` checks these rules (`scripts/check-boundaries.mjs`).

## Development

To work on the plugin, load it from your checkout instead: `npm run build:claude-plugin`, then `claude --plugin-dir adapters/claude-code/plugin`. Its bundles (`plugin/bin/lr`, `plugin/hooks/local-review-hook.js`) are committed, so that the plugin installs from git: `npm test` fails when they are out of date.

Requirements: Node ≥ 20 and the `code` command on your PATH.

```sh
npm install
npm run typecheck          # TypeScript, all packages
npm test                   # unit tests (vitest)
npm run test:integration   # integration tests in a dedicated VS Code instance
npm run install-ext        # build the .vsix and install it into VS Code
```

After `install-ext`, run **Developer: Reload Window** in VS Code.

## License

[MIT](LICENSE)

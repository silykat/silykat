# local-review

Skills & VSCode extension for local code review.

A GitHub-style code review between you and your AI coding agent, running 100% locally. It is LLM-agnostic: Claude Code is the first supported agent.

- **VS Code extension** (`packages/extension`): select lines in a file or a diff and comment on them, either as a direct comment or as part of a review.
- **Agent integration** (coming soon): the agent reads the comments, updates the code and replies in the threads. It starts with a Claude Code skill, built on an agent-neutral CLI.

Comments are stored in `.local-review/` at the root of the reviewed project. That folder is automatically excluded from git through `.git/info/exclude`. No data ever leaves your machine.

## Usage

Select lines, then use **Local Review: Comment on Selection** from the editor context menu, or press **`Ctrl+Cmd+C`** (`Ctrl+Alt+C` on Windows/Linux).

The shortcut can be changed in `settings.json`:

```jsonc
"localReview.commentShortcut": "ctrl+cmd+c" // or "ctrl+alt+c", "cmd+alt+m", "none"
```

For any other key combination, set it to `"none"` and bind the `localReview.commentSelection` command in `keybindings.json`.

The agent's replies appear live in the thread, signed with the agent's name, with a status label: **Waiting for Claude**, **💬 Claude replied**, **❓ Claude is waiting for your reply** or **✅ Addressed by Claude — please verify**. Until an agent is plugged in, the default agent name is Claude.

Reply in the thread with **Reply** (or `Cmd+Enter`). Replying to a question, or to a thread the agent marked as addressed, hands the thread back to the agent: it shows **Waiting for Claude** again.

Only you can close a thread: **Resolve** (✓ in the thread header) marks it resolved and collapses it, and **Reopen** hands it back to the agent. The Comments panel can filter resolved threads out. Replying in a resolved thread reopens it.

You can **Edit** or **Delete** your own comments (the agent's are read-only), and **Delete Thread** from its header. Deleting asks for confirmation; deleting the last comment deletes the thread. Deleted threads disappear from VS Code, but the history stays in the journal.

Threads follow the code: when lines are added or removed above a thread, or inside it, the thread moves with them. The new position is recorded when you save the file, and dropped if you close it without saving. When the file changes outside the editor (another tool, `git stash`, or while VS Code was closed), the thread finds its code again.

When a thread's code disappears (rewritten or deleted elsewhere, stashed away, or the file is gone), the thread is marked **⚠️ Outdated**, like on GitHub: it moves to line 1 instead of staying on lines that are not its code, and quotes the original code. You can still reply, resolve or delete it. Whitespace-only changes (re-indentation, spacing) do not make a thread outdated, and it attaches again by itself if its code comes back (e.g. `git stash pop`).

**Review mode.** Instead of **Comment**, click **Start Review**: the comment is saved as a **Pending** draft, and the status bar shows **Review · N**. While the review is in progress, **Add to Review** adds more drafts, and **Comment Now** still publishes right away. Click the status bar to **Submit Review**, with an optional summary, or to **Show Pending Comments**. During a review, replying in a published thread offers **Add to Review** (a draft reply, published with the review; it then hands the thread back to the agent) and **Reply Now**. **Discard Review** deletes all drafts after confirmation: threads that only held drafts disappear, published threads are kept. Drafts survive a restart, and the agent does not see them until the review is submitted.

Until the first agent integration ships, **Local Review (dev): Simulate Agent Reply** writes a reply as the agent from a separate process, through the same path a real integration will use.

## Development

Requirements: Node ≥ 20 and the `code` command on your PATH.

```sh
npm install
npm run typecheck          # TypeScript, all packages
npm test                   # unit tests (vitest)
npm run test:integration   # integration tests in a dedicated VS Code instance
npm run install-ext        # build the .vsix and install it into VS Code
```

After `install-ext`, run **Developer: Reload Window** in VS Code.

| Package              | Purpose                                                       |
| -------------------- | ------------------------------------------------------------- |
| `packages/core`      | Data model, JSONL journal, storage. No dependency on `vscode` |
| `packages/extension` | VS Code extension                                             |

## License

[MIT](LICENSE)

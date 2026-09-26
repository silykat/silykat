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

| Package | Purpose |
|---|---|
| `packages/core` | Data model, JSONL journal, storage. No dependency on `vscode` |
| `packages/extension` | VS Code extension |

## License

[MIT](LICENSE)

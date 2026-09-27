# Contributing to Local Review

Thanks for your interest! This guide covers the development setup, the tests and the conventions of the project. [docs/architecture.md](docs/architecture.md) explains how the pieces fit together.

## Development setup

Requirements: Node.js 20 or later, npm, git, VS Code with the `code` command on your PATH, and Claude Code to work on the agent integration.

```sh
git clone git@github.com:lbenamer/local-review.git
cd local-review
npm install
```

The repository is an npm workspaces monorepo: `packages/core`, `packages/cli`, `packages/vscode-extension` and `adapters/claude-code`.

## Everyday commands

| Command                       | What it does                                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`           | TypeScript checks, all packages                                                                                   |
| `npm test`                    | Unit tests (vitest), dependency boundaries, and the freshness of the committed plugin bundles                     |
| `npm run test:integration`    | Integration tests in a dedicated VS Code instance (downloaded into `.vscode-test/`), on a temporary git workspace |
| `npm run format`              | Prettier (`npm run format:check` to only check)                                                                   |
| `npm run install-ext`         | Build the `.vsix` and install it into your VS Code (then **Developer: Reload Window**)                            |
| `npm run build:claude-plugin` | Rebuild the plugin bundles (`plugin/bin/lr`, `plugin/hooks/`, `plugin/channel/`)                                  |

## Working on the Claude Code plugin

- Load your checkout for skills and hooks: `claude --plugin-dir adapters/claude-code/plugin`. The channel, however, only works with the installed plugin (`--dangerously-load-development-channels plugin:local-review@local-review`): add your checkout as a local marketplace (`claude plugin marketplace add /path/to/local-review`), then `claude plugin update local-review@local-review` after each change.
- After any change to `core`, the CLI or the adapter, run `npm run build:claude-plugin` and **commit the bundles**: Claude Code installs plugins from git, and `npm test` fails when they are stale.
- **Bump the plugin version** in `adapters/claude-code/plugin/.claude-plugin/plugin.json` for every change you ship: Claude Code only updates a plugin whose version changed.

### Without an agent

**Local Review (dev): Simulate Agent Reply** (command palette) writes a reply as the agent from a separate process, through the same path a real agent uses: handy to work on the extension without running Claude.

### Testing with a real Claude Code

Unit and integration tests do not run Claude. For behaviour that depends on Claude Code (hooks, channel, skill), check it for real, cheaply:

- `claude -p --model haiku …` in a throwaway git repository, with a private `LOCAL_REVIEW_HOME`, so that nothing mixes with your real sessions;
- `SessionEnd` unregisters the session when `claude -p` exits: watch the registry while it runs;
- `--debug` writes a log to `~/.claude/debug/<session-id>.txt` (hooks, MCP servers).

Verify technical assumptions (what a hook receives, when a channel message arrives…) by trying them: documentation can be ambiguous.

## Conventions

- **English everywhere in the repository**: code, comments, docs, commit messages, and the whole user interface.
- **TypeScript strict**, bundled with esbuild. Prettier (single quotes, 120 columns, trailing commas; version pinned): run `npm run format` before committing.
- **Lines are 1-based and inclusive** in the stored format and in `lr`; the conversion to VS Code's 0-based ranges happens in the extension only.
- **Every access to the stored data goes through `core`**. A format change means a schema version bump and a migration in `core`.
- **No network calls and no telemetry**, anywhere. `npm run package` checks the extension bundle for it.
- **Tests are named by feature** (`review-mode.test.ts`), never after a ticket, so that a file can take the tests added later on the same feature.
- Integration tests drive the extension through the API returned by `activate()`. A test file that registers sessions or leaves comments waiting cleans up after itself, and no test relies on the window having the system focus.

## Pull requests

- Branch from `main` (it is protected: every change goes through a pull request).
- Keep commits small and coherent, with an English message that says why.
- Before opening the PR: `npm run typecheck`, `npm test` and `npm run test:integration` pass, `npm run format:check` reports nothing, and the plugin bundles are rebuilt and committed if needed.
- Describe what changes for the user, how, and how it was tested (including with a real Claude Code when relevant).

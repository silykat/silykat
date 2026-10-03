# Contributing to Local Review

Thanks for your interest! This guide covers the development setup, the tests and the conventions of the project. [docs/architecture.md](docs/architecture.md) explains how the pieces fit together.

## Development setup

Requirements: git, VS Code with the `code` command on your PATH, Claude Code to work on the agent integration, and Node.js 22.12 or later with npm 11.10 or later: `npm install` refuses older versions, and says which ones it needs. [`.nvmrc`](.nvmrc) gives the reference version, the one the CI uses.

```sh
git clone git@github.com:lbenamer/local-review.git
cd local-review
nvm use        # optional: the reference version of .nvmrc
npm install    # also installs the git hooks
```

The repository is an npm workspaces monorepo: `packages/core`, `packages/cli`, `packages/vscode-extension` and `adapters/claude-code`.

## Everyday commands

| Command                        | What it does                                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`            | TypeScript checks, all packages                                                                                               |
| `npm run lint`                 | oxlint, with type information, on the whole repository                                                                        |
| `npm test`                     | Unit tests (vitest), dependency boundaries, and the freshness of the committed plugin bundles                                 |
| `npm run test:integration`     | Integration tests in a dedicated VS Code instance (downloaded into `.vscode-test/`), on a temporary git workspace             |
| `npm run test:linux`           | The whole suite (checks, unit and integration tests) on Linux, in a Docker container: see below                               |
| `npm run coverage`             | Coverage of the unit tests (report in `coverage/unit/`); fails below the floors of `vitest.config.mjs`                        |
| `npm run coverage:integration` | Coverage of the integration tests (report in `coverage/integration/`); fails below the floors of `scripts/check-coverage.mjs` |
| `npm run format`               | Prettier (`npm run format:check` to only check)                                                                               |
| `npm run install-ext`          | Build the `.vsix` and install it into your VS Code (then **Developer: Reload Window**)                                        |
| `npm run build:claude-plugin`  | Rebuild the plugin bundles (`plugin/bin/lr`, `plugin/hooks/`, `plugin/channel/`)                                              |

## Continuous integration

Every pull request to `main`, to an `epic/*` branch or to a `feat/*` branch (a story stacked on the previous one) runs [`.github/workflows/ci.yml`](.github/workflows/ci.yml), on Linux:

- **Pull request title** ([`.github/workflows/pr-title.yml`](.github/workflows/pr-title.yml), checked again when the title is edited): Conventional Commits (commitlint);
- **Checks, unit tests and package**: typecheck, lint, format, unit tests (with dependency boundaries and plugin bundles), coverage floors, and the `.vsix`, downloadable from the run's artifacts;
- **Integration tests (Linux)**: in the image of `npm run test:linux`.

The macOS integration tests run on the maintainer's machine for now; the macOS job only runs when started by hand (it costs ten times the minutes of Linux on a private repository). Actions are pinned by commit, and [Dependabot](.github/dependabot.yml) proposes updates every week, never of a version published less than 7 days ago.

## Testing on Linux

`npm run test:linux` builds a Linux image (`scripts/linux/Dockerfile`: the Node.js of `.nvmrc`, and what VS Code needs) and runs in it what `scripts/linux/run-tests.sh` lists: typecheck, lint, format, unit tests, and the integration tests on a virtual display (`xvfb-run`). It needs Docker. The first run downloads VS Code for Linux into a Docker volume (`local-review-linux-vscode`), kept for the next runs. The CI is to reuse the same image.

On a Mac with Apple silicon, the container is Linux arm64; the CI runs on x86-64.

## Working on the Claude Code plugin

- Load your checkout for skills and hooks: `claude --plugin-dir adapters/claude-code/plugin`. The channel, however, only works with the installed plugin (`--dangerously-load-development-channels plugin:local-review@local-review`): add your checkout as a local marketplace (`claude plugin marketplace add /path/to/local-review`), then `claude plugin update local-review@local-review` after each change.
- After any change to `core`, the CLI or the adapter, run `npm run build:claude-plugin` and **commit the bundles**: Claude Code installs plugins from git, and `npm test` fails when they are stale.
- Never bump the plugin version by hand: releases do it (see below). Claude Code only updates a plugin whose version changed.
- The hook saves the threads of a git worktree before Claude removes it (`PreToolUse`): its parsing of shell commands (`worktreeRemovals`) is unit-tested with fake helpers; to try it for real, run `claude -p --model haiku` in a throwaway repository with a worktree that has a comment, ask it to remove the worktree, then check `lr history`. Its setting, `keep-history`, lives in the machine settings (`lr config`), as the hook runs outside VS Code; the extension mirrors `localReview.keepHistory` there.
- The retro (`/local-review:retro`) runs three sub-agents of the plugin (`agents/`: classification, analysis, application), and `bin/lr-retro`, bundled from `adapters/claude-code/src/retroMain.ts`. Its audit (`lr-retro audit`) starts a separate `claude -p`: tests give it a fake runner (`run` of `runRetroCli`), and `LR_CLAUDE_BIN` points it at another `claude` binary. Its Jev classification is tested against a local stub: `LR_JEV_URL` points `lr-retro jev` at another address (tests only). Never use a real key in tests.
- The retro reminder: the `SessionStart` hook asks Claude to mention a due retro (`additionalContext`); it is unit-tested with a fake cadence. To try it for real, give a throwaway project a finished retro whose period ended more than 7 days ago (write its journal with `RetroBook`, or run a retro and wait), and a thread since then, then run `claude -p --model haiku "hello"` there with a private `LOCAL_REVIEW_HOME`. Its thresholds are machine settings (`lr config`), mirrored from the `localReview.retroReminder.*` settings by the extension.
- Claude Code's transcripts (`~/.claude/projects/…/<session>.jsonl`) are an internal format: only `adapters/claude-code/src/retroConversation.ts` reads them, for `lr-retro conversation`. Its tests build transcripts shaped like real ones in a temporary `CLAUDE_CONFIG_DIR`; when Claude Code changes the format, check a real one (a `claude -p --model haiku` run that replies with `lr reply`, then `lr-retro conversation`).

### Without an agent

**Local Review (dev): Simulate Agent Reply** (command palette) writes a reply as the agent from a separate process, through the same path a real agent uses: handy to work on the extension without running Claude.

### Testing with a real Claude Code

Unit and integration tests do not run Claude. For behaviour that depends on Claude Code (hooks, channel, skill), check it for real, cheaply:

- `claude -p --model haiku …` in a throwaway git repository, with a private `LOCAL_REVIEW_HOME`, so that nothing mixes with your real sessions;
- a retro asks questions: in `claude -p`, give the answers in the prompt, and use `--permission-mode acceptEdits` so that it can only change files of the throwaway folder (its sub-agents run with the model of their file: Haiku, Opus and Sonnet);
- `SessionEnd` unregisters the session when `claude -p` exits: watch the registry while it runs;
- `--debug` writes a log to `~/.claude/debug/<session-id>.txt` (hooks, MCP servers).

Verify technical assumptions (what a hook receives, when a channel message arrives…) by trying them: documentation can be ambiguous.

## Dependencies

- **Exact versions only** (`.npmrc`: `save-exact`), and `npm ci` to install from the lockfile.
- **No version published less than 7 days ago** (`.npmrc`: `min-release-age=7`), against supply-chain attacks: npm refuses it. A needed exception is decided by the maintainer, for one command (`--min-release-age-exclude=<package>`), never in `.npmrc`.
- The product has **no runtime dependency** outside the repository: everything in `package.json` is a development tool.

## Git hooks

`npm install` installs them (husky):

- **pre-commit**: formats the staged files with Prettier (a file with unstaged changes is only checked), then runs `npm run lint`;
- **commit-msg**: the message must follow Conventional Commits (commitlint, see below).

## Conventions

- **English everywhere in the repository**: code, comments, docs, commit messages, and the whole user interface.
- **TypeScript strict**, bundled with esbuild. Prettier (single quotes, 120 columns, trailing commas; version pinned): run `npm run format` before committing. **oxlint** (`.oxlintrc.json`) with type information: `npm run lint` reports nothing.
- **Lines are 1-based and inclusive** in the stored format and in `lr`; the conversion to VS Code's 0-based ranges happens in the extension only.
- **Every access to the stored data goes through `core`**. A format change means a schema version bump and a migration in `core`. What older versions safely ignore needs no bump: an optional field of an event (like the `reason` of `thread.deleted`), or a new folder of the store they never read (`retros/`, `saved/`). A new event type does (the archive events, version 2): give it the new version in its `v` (`eventVersion` in `core/src/events.ts`) and keep `v: 1` on the others, so that older versions only lose the threads that use it (read-only, with the "update Local Review" message).
- **No network calls and no telemetry**, anywhere. `npm run package` checks the extension bundle for it.
- **Tests are named by feature** (`review-mode.test.ts`), never after a ticket, so that a file can take the tests added later on the same feature.
- **No test depends on the day it runs.** The unit tests run on a clock that starts at a fixed date (2026-10-03T12:00:00Z), then moves on in real time (`test/fixed-clock.mjs`, the setup file of every vitest project): a date written in a test never becomes past or future. File and git dates stay real: a test that compares to them starts from them (the mtime of a file it just wrote), never from the clock. The integration tests run on the real clock, and only compare relative dates.
- Integration tests drive the extension through the API returned by `activate()`. A test that needs its own git history (commits, worktrees) uses a throwaway repository rather than the test workspace, whose state the other test files share. A test file that registers sessions or leaves comments waiting cleans up after itself, and no test relies on the window having the system focus.

## Releases

The extension and the plugin (with its `lr`) share **one version**. [release-please](https://github.com/googleapis/release-please) derives it from the Conventional Commits of `main` (`.github/workflows/release.yml`, `release-please-config.json`):

- `feat` → minor, `fix` → patch, a breaking change → minor while in 0.x; `chore`, `ci`, `docs`, `test` and `build` alone make no release;
- after each merge into `main`, the release pull request is opened or updated, with the next version and `CHANGELOG.md`;
- merging it tags `vX.Y.Z` and creates the GitHub release. Nothing is published to a marketplace yet;
- the checks of the release pull request need an approval (**Approve and run workflows** on the pull request), as GitHub Actions opened it;
- `npm run build:release` builds the deliverables of the current version: the plugin bundles and the `.vsix`.

Versions are never bumped by hand. The store format has its own version (`v` in each event): an extension or an `lr` that meets a newer format keeps those comments read-only and says to update Local Review.

## Branches

- A user story, a fix or a chore: a branch from `main`, one pull request, merged with a squash.
- An **epic** (a feature made of several user stories): an `epic/<slug>` branch from `main`. Each story reaches it by its own pull request; the epic reaches `main` by one pull request, merged with a squash. Its description ends with a `BEGIN_COMMIT_OVERRIDE` … `END_COMMIT_OVERRIDE` block, one line per change users can see, which release-please uses instead of the squashed commit message (the `changelog-digest` skill in `.claude/skills/` writes it). Fixes go to `main`, then `main` is merged into the epic branches in progress.

## Commits and pull requests

- Branch from `main` (it is protected: every change goes through a pull request, merged with a squash).
- Keep commits small and coherent. Commit messages and pull request titles follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/): `<type>(<scope>): <description>`, in English, imperative, lower case, no final period.
  - Types: `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, `perf`, `chore`.
  - Scopes: `core`, `cli`, `vscode-extension`, `claude-code`, `deps`, or none when the change touches several parts.
  - A breaking change (the `.local-review/` format, the `lr` commands, the settings): `!` after the scope and a `BREAKING CHANGE: …` footer.
- Before opening the PR: `npm run typecheck`, `npm run lint`, `npm test` and `npm run test:integration` pass, `npm run format:check` reports nothing, and the plugin bundles are rebuilt and committed if needed.
- Describe what changes for the user, how, and how it was tested (including with a real Claude Code when relevant).

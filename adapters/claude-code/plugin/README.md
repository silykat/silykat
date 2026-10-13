# silykat for Claude Code

**A GitHub-style code review between you and Claude Code, 100% local.**

You leave comments on your code in VS Code with the [silykat extension](https://github.com/silykat/silykat#readme), like on a pull request. This plugin lets Claude receive them on its own, change the code, and reply in each thread: done, or a precise question. It also runs **retros** of your work with Claude: it looks back at your review threads, your sessions with Claude and an audit of its setup, and you decide together what to keep, remove or improve in that setup (`CLAUDE.md`, skills, hooks…).

## Install

```sh
claude plugin marketplace add silykat/silykat
claude plugin install silykat@silykat
claude --dangerously-load-development-channels plugin:silykat@silykat
```

The channel is what lets your comments reach Claude by themselves (Claude Code channels are a research preview). Without it, Claude reads the comments when you ask: `/silykat:review`.

## What it adds

- **Skills**: `/silykat:review` (address the review comments and reply in their threads) and `/silykat:retro` (run a retro).
- **Commands**: `/silykat:subscribe` and `/silykat:unsubscribe` (which branch or folder this session receives comments for).
- **Agents**: the `silykat:retro-*` sub-agents that classify, read and analyse the sources of a retro, and apply the changes you validate.
- **The `slk` command line** (`bin/slk`), on Claude's PATH: it reads and answers threads and keeps the retros' journals.

## What it runs and where your data goes

Everything stays on your machine, in plain files: `.silykat/` in your repositories and `~/.silykat/`.

- **Hooks** (`hooks/silykat-hook.js`, Node.js): at the start and end of a session, they register the session so that comments reach it; after a tool use, they subscribe the session to the branch of a file it changed; before a command that removes a git worktree, they save its threads.
- **A local MCP server** (`channel/silykat-channel.js`, Node.js, over stdio): the channel that hands Claude the comments you publish. It opens no network connection.
- **Retros** run separate Claude Code processes (`claude -p`, read-only) to write a report on each of your sessions and to audit your setup, and read Claude Code's own session records in `~/.claude/projects/`.
- **The only network call** is optional: during a retro, if you set up a key for [Jev](https://jevtypesafeai.com/) (a classification service), each review thread is sent to it, with the project's rules files (`CLAUDE.md`…), to classify it. Without a key, Claude (Haiku) does it, and nothing is sent anywhere. No telemetry.

The bundled files (`bin/`, `hooks/`, `channel/`) are built from the TypeScript sources of the [repository](https://github.com/silykat/silykat) (`packages/`, `adapters/claude-code/src/`).

## Learn more

The full guide: [github.com/silykat/silykat](https://github.com/silykat/silykat#readme). Issues and ideas: [github.com/silykat/silykat/issues](https://github.com/silykat/silykat/issues).

## License

MIT, see [LICENSE](LICENSE).

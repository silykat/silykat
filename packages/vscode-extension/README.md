# silykat

**The code review that makes your agent better.**

Comment on lines in VS Code, like on a pull request. Your agent (Claude Code for now) fixes the code, answers in the thread, and learns from your feedback through retros. No pull request, no server, no account: comments live next to your code, and nothing leaves your machine.

This extension is the VS Code side. The [Claude Code plugin](#the-claude-code-plugin) is the agent side.

## Features

- **Comments anywhere**: selected lines, a whole file, both sides of a diff (working tree, staged changes, past commits, file comparisons), even files outside the folders open in VS Code.
- **Direct comments or reviews**: publish a comment right away, or collect drafts and submit them as one review with a summary.
- **Threads that follow the code**: they move with the lines, find their code again after external changes, and turn **Outdated** when it is gone.
- **Threads that belong to their git branch**: switch branches and you only see that branch's threads.
- **Your agent does the work**: it receives what you publish, changes the code, replies in each thread, and tells you what it did or what it needs.
- **The right agent gets it**: with several agent sessions in parallel, each comment goes to the sessions working on its branch.
- **Your whole history**: read back every thread of a project, archive finished ones, export them, or keep no history at all.
- **Retros with your agent**: look back at your work with Claude (your review threads, your sessions with it, an audit of its setup), and decide together what to keep, remove or improve in its setup. The status bar tells you when a retro is due.
- **100% local**: no network calls, no telemetry, plain files you can read.

## Quick start

1. Install this extension, then the Claude Code plugin (below).
2. Start Claude Code with the silykat channel in your repository, and ask it to `subscribe to this branch`.
3. Select lines and press **`Ctrl+Cmd+C`** (`Ctrl+Alt+C` on Windows and Linux), or right-click and choose **Comment on Selection**.
4. Claude receives the comment within seconds, changes the code and replies in the thread. Check the change, reply if needed, and click **Resolve** to close the thread.

## The Claude Code plugin

```sh
claude plugin marketplace add silykat/silykat
claude plugin install silykat@silykat
claude --dangerously-load-development-channels plugin:silykat@silykat
```

The channel lets your comments reach Claude by themselves. Channels are a Claude Code research preview, hence the long launch command: add an alias for it.

## Requirements

- VS Code 1.100 or later, or an editor based on it (Cursor, VSCodium, Windsurf…).
- For the agent integration: Claude Code in a terminal.

## Learn more

The full guide (reviews, diffs, branches and worktrees, retros, settings, the `slk` command line, where your data lives): [silykat.com/docs](https://silykat.com/docs).

Report a bug or suggest an idea: [issues](https://github.com/silykat/silykat/issues).

## License

[MIT](https://github.com/silykat/silykat/blob/main/LICENSE)

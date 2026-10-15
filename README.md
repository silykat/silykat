# silykat

**The code review that makes your agent better.**

Comment on lines in VS Code, like on a pull request. Your agent (Claude Code for now) fixes the code, answers in the thread, and learns from your feedback through retros. No pull request, no server, no account: comments live next to your code, and nothing leaves your machine.

**Documentation: [silykat.com/docs](https://silykat.com/docs)**

[![CI](https://github.com/silykat/silykat/actions/workflows/ci.yml/badge.svg)](https://github.com/silykat/silykat/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/silykat/silykat)](https://github.com/silykat/silykat/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

```text
  You, in VS Code                        Your agent (Claude Code)
  ---------------                        ------------------------
  comment lines, a file, a diff   -->    receives the comments on its own
  or submit a whole review               changes the code
  see the answers live            <--    replies in each thread: done, or a question
  resolve when satisfied
```

## Features

- **Comments anywhere**: selected lines, a whole file, both sides of a diff, even files outside the folders open in VS Code.
- **Comments or reviews**: publish a comment right away, or collect drafts and submit them as one review.
- **Threads that follow the code**: they move with the lines, and belong to their git branch.
- **Your agent does the work**: it receives what you publish, changes the code, and replies in each thread.
- **Retros**: look back at your feedback and your sessions with Claude, and improve its setup together (`CLAUDE.md`, skills, hooks).
- **100% local**: no network calls, no telemetry, plain files you can read. The one exception is opt-in: an online classifier for your retros, only if you give it a key.

## Install

```sh
code --install-extension silykat.silykat
claude plugin marketplace add silykat/silykat
claude plugin install silykat@silykat
```

Then start Claude Code with the silykat channel, and leave your first comment: see [Install](https://silykat.com/docs/install) and the [Quick start](https://silykat.com/docs/quick-start).

The extension is on the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=silykat.silykat) and on [Open VSX](https://open-vsx.org/extension/silykat/silykat).

## Documentation

The user guide lives in [`docs/guide/`](docs/guide/) and is published on [silykat.com/docs](https://silykat.com/docs). [`docs/architecture.md`](docs/architecture.md) explains how the pieces fit together.

## Contributing

Contributions are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers the development setup, tests and conventions.

## License

[MIT](LICENSE)

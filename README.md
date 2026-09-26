# local-review

Skills & VSCode extension for local code review.

A GitHub-style code review between you and Claude Code, running 100% locally:

- **VS Code extension** (`packages/extension`): select lines in a file or a diff and comment on them, either as a direct comment or as part of a review.
- **Claude Code skill** (coming soon): Claude reads the comments, updates the code and replies in the threads.

Comments are stored in `.local-review/` at the root of the reviewed project. That folder is automatically excluded from git through `.git/info/exclude`. No data ever leaves your machine.

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

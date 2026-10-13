// Conventional Commits, with the parts of the repository as scopes (see CONTRIBUTING.md).
export default {
  extends: ['@commitlint/config-conventional'],
  helpUrl: 'https://github.com/silykat/silykat/blob/main/CONTRIBUTING.md#commits-and-pull-requests',
  rules: {
    'scope-enum': [2, 'always', ['core', 'cli', 'vscode-extension', 'claude-code', 'deps']],
  },
};

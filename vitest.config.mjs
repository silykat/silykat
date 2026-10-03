import { defineConfig } from 'vitest/config';

// Coverage of the unit tests of every package, in one report (`npm run coverage`, in `coverage/unit/`).
// Each package still runs its own tests with `npm test`.
export default defineConfig({
  test: {
    projects: ['packages/core', 'packages/cli', 'packages/vscode-extension', 'adapters/claude-code'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'adapters/claude-code/src/**/*.ts'],
      // Not worth unit tests: entry points that only wire the rest together, and development tools.
      exclude: [
        'packages/cli/src/main.ts',
        'adapters/claude-code/src/hookMain.ts',
        'adapters/claude-code/src/channelMain.ts',
        'packages/vscode-extension/src/dev/**',
      ],
      reporter: ['text', 'html'],
      reportsDirectory: 'coverage/unit',
      // Floors at the level reached, rounded down: the CI measures on Linux, a bit below macOS for some
      // branches. Raise them when the coverage goes up, never lower them. The
      // extension is mostly covered by its integration tests (`npm run coverage:integration`).
      thresholds: {
        'packages/core/src/**': { statements: 94, branches: 89, functions: 93, lines: 96 },
        'packages/cli/src/**': { statements: 97, branches: 86, functions: 98, lines: 99 },
        'adapters/claude-code/src/**': { statements: 95, branches: 82, functions: 97, lines: 99 },
        'packages/vscode-extension/src/**': { statements: 4, branches: 6, functions: 4, lines: 4 },
      },
    },
  },
});

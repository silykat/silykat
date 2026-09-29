import { defineConfig } from 'vitest/config';

// Coverage of the unit tests of every package, in one report (`npm run coverage`, in `coverage/unit/`).
// Each package still runs its own tests with `npm test`.
export default defineConfig({
  test: {
    projects: ['packages/core', 'packages/cli', 'packages/vscode-extension', 'adapters/claude-code'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'adapters/claude-code/src/**/*.ts'],
      reporter: ['text', 'html'],
      reportsDirectory: 'coverage/unit',
      // Floors at the level reached: raise them when the coverage goes up, never lower them. The
      // extension is mostly covered by its integration tests (`npm run coverage:integration`).
      thresholds: {
        'packages/core/src/**': { statements: 93, branches: 88, functions: 91, lines: 95 },
        'packages/cli/src/**': { statements: 94, branches: 86, functions: 90, lines: 95 },
        'adapters/claude-code/src/**': { statements: 78, branches: 77, functions: 65, lines: 80 },
        'packages/vscode-extension/src/**': { statements: 4, branches: 6, functions: 4, lines: 4 },
      },
    },
  },
});

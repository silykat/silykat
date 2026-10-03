import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { setupFiles: ['../../test/fixed-clock.mjs'] },
});

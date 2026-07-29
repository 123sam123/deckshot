import { defineConfig } from 'vitest/config';

/**
 * Vitest deliberately gets its own config.
 *
 * `vite.config.ts` sets `root: 'client'` so the client build works, and vitest
 * inherits that root if it has nowhere else to look — which makes it scan
 * `client/` and report "No test files found" for every test in `tests/`.
 * A separate config file takes precedence and keeps the test root at the repo
 * root, where the tests actually live.
 */
export default defineConfig({
  test: {
    root: '.',
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});

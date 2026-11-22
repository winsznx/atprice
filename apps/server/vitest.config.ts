import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/live/**'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Integration tests share one Postgres database, so files run one at a time.
    fileParallelism: false,
  },
});

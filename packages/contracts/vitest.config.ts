import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Tests drive the real builders from @atprice/core, which itself depends on this package's
    // artifacts. Resolving core from source keeps the workspace dependency graph acyclic.
    alias: { '@atprice/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)) },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
});

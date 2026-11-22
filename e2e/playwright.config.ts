import { defineConfig, devices } from '@playwright/test';
import { webOrigin } from './src/target';

/*
 * Runs only against a local build of apps/web pointed at a local apps/server. Nothing here starts a
 * server, so what is captured is exactly the build under review:
 *   NEXT_PUBLIC_ATPRICE_NETWORK=chipnet NEXT_PUBLIC_API_URL=http://localhost:4000 pnpm --filter @atprice/web build
 *   pnpm --filter @atprice/web start            (with the API listening on :4000)
 *   pnpm screens                                  (E2E_BASE_URL / E2E_API_URL to change ports)
 * `src/target.ts` refuses any non-local origin by name.
 */
export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  fullyParallel: false,
  workers: 2,
  retries: 0,
  forbidOnly: process.env.CI !== undefined,
  reporter: [['list']],
  timeout: 60_000,
  use: {
    baseURL: webOrigin,
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    {
      name: 'screens',
      testMatch: 'screens.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});

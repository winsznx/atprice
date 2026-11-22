import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { loadFixtures, ROUTES, VIEWPORTS, type FixtureSource } from '../src/routes';
import { assertWebOnLocalApi, FULL_PAGE, SCREENS_DIR } from '../src/target';

const SETTLE_MS = 10_000;

let source: FixtureSource;

test.beforeAll(async () => {
  await assertWebOnLocalApi();
  source = await loadFixtures();
  mkdirSync(SCREENS_DIR, { recursive: true });
});

/** Waits until no loading region is left, so the shot shows data, an empty state or a named error. */
const settle = async (page: Page): Promise<string | null> => {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  try {
    await page.waitForFunction(() => document.querySelector('[aria-busy="true"]') === null, null, {
      timeout: SETTLE_MS,
    });
    return null;
  } catch {
    return `still loading after ${SETTLE_MS / 1000} s; captured as it was`;
  }
};

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const route of ROUTES) {
      test(route.name, async ({ page }, testInfo) => {
        for (const note of source.notes) testInfo.annotations.push({ type: 'fixture', description: note });
        const target = route.path(source.fixtures);
        test.skip(typeof target !== 'string', typeof target === 'string' ? '' : target.skip);
        if (typeof target !== 'string') return;

        const response = await page.goto(target, { waitUntil: 'load' });
        expect(response, `no response for ${target}`).not.toBeNull();
        const unsettled = await settle(page);
        if (unsettled !== null) testInfo.annotations.push({ type: 'settle', description: unsettled });

        const file = path.join(SCREENS_DIR, `${route.name}-${viewport.width}x${viewport.height}.png`);
        await page.screenshot({ path: file, fullPage: FULL_PAGE, animations: 'disabled' });

        // DD 5.10: no sideways scroll at any review width, the 320px floor included.
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect.soft(overflow, `${target} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(0);
      });
    }
  });
}

import { validatePublicEnv, type PublicEnv } from './schema';

/**
 * Validated build-time configuration. Every key is spelled out literally because Next only inlines
 * `process.env.NEXT_PUBLIC_*` references it can see statically. next.config.ts runs the same
 * validation, so a bad value fails the build before this module is ever loaded in a browser.
 */
export const publicEnv: PublicEnv = validatePublicEnv({
  NEXT_PUBLIC_ATPRICE_NETWORK: process.env.NEXT_PUBLIC_ATPRICE_NETWORK,
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
  NEXT_PUBLIC_BUILD_SHA: process.env.NEXT_PUBLIC_BUILD_SHA,
  NEXT_PUBLIC_BLAZE_DECK_URL: process.env.NEXT_PUBLIC_BLAZE_DECK_URL,
  NEXT_PUBLIC_SOURCE_REPO_URL: process.env.NEXT_PUBLIC_SOURCE_REPO_URL,
  NEXT_PUBLIC_EMBER_ADDRESS: process.env.NEXT_PUBLIC_EMBER_ADDRESS,
});

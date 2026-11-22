import type { RecoverConfig } from '../config';

declare global {
  /** Replaced by the build (`scripts/build.ts`, esbuild `define`): one value per file. */
  const __RECOVER_CONFIG__: RecoverConfig;
}

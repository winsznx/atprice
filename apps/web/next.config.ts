import { execFileSync } from 'node:child_process';
import type { NextConfig } from 'next';

const shortSha = (sha: string): string => sha.trim().slice(0, 7);

/** Footer build version (DD 8): explicit env first, then the Vercel build's commit, then the local checkout. */
const resolveBuildSha = (): string | undefined => {
  const explicit = process.env.NEXT_PUBLIC_BUILD_SHA;
  if (explicit !== undefined && explicit.trim() !== '') return explicit.trim();
  const vercel = process.env.VERCEL_GIT_COMMIT_SHA;
  if (vercel !== undefined && vercel.trim() !== '') return shortSha(vercel);
  try {
    return shortSha(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }));
  } catch (error) {
    console.error('Could not read the git commit for NEXT_PUBLIC_BUILD_SHA:', error);
    return undefined;
  }
};

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  },
];

export default function config(): NextConfig {
  const buildSha = resolveBuildSha();
  // Env validation runs where the values are used: lib/env/public.ts validates at module load, and
  // `next build` evaluates it (layout, footer, proxy), so a missing or invalid value fails the build with
  // a named EnvError (ENV_API_URL_MISSING, BLAZE_EMBER_ADDRESS_INVALID, ...). It can't run here: this
  // file is compiled to CommonJS and libauth, which the EMBER address check needs, uses top-level await.
  // The Content-Security-Policy is set per request in proxy.ts, because a strict script policy needs a
  // fresh nonce for every page.
  return {
    reactStrictMode: true,
    poweredByHeader: false,
    // Phosphor's entries are barrels over ~9,000 icon modules; import only the ones a page names.
    experimental: { optimizePackageImports: ['@phosphor-icons/react', '@phosphor-icons/react/dist/ssr'] },
    env: buildSha === undefined ? {} : { NEXT_PUBLIC_BUILD_SHA: buildSha },
    async headers() {
      return [{ source: '/:path*', headers: securityHeaders }];
    },
  };
}

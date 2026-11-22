import path from 'node:path';

/*
 * These checks only ever run against a web app and API on this machine. A production or preview
 * URL is refused by name, because screenshots of a shared deployment would read its users' state
 * and the review is about the build in this checkout.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export class TargetError extends Error {
  constructor(
    readonly code:
      'E2E_TARGET_NOT_LOCAL' | 'E2E_TARGET_INVALID' | 'E2E_WEB_UNREACHABLE' | 'E2E_WEB_NOT_ON_LOCAL_API',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'TargetError';
  }
}

const localOrigin = (name: string, fallback: string): string => {
  const raw = process.env[name]?.trim() || fallback;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TargetError('E2E_TARGET_INVALID', `${name}=${raw} is not a URL.`);
  }
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new TargetError(
      'E2E_TARGET_NOT_LOCAL',
      `${name}=${raw} is not on this machine; run against a local build.`,
    );
  }
  return url.origin;
};

/** The local `next start` (or `next dev`) of apps/web. */
export const webOrigin = localOrigin('E2E_BASE_URL', 'http://localhost:3000');

/** The local apps/server API origin the web build was given as `NEXT_PUBLIC_API_URL`. */
export const apiOrigin = localOrigin('E2E_API_URL', 'http://localhost:4000');

export const SCREENS_DIR = path.resolve(import.meta.dirname, '../../recordings/screens');

/** Viewport-only shots by default, so a full run stays a few megabytes; `E2E_FULL_PAGE=1` for whole pages. */
export const FULL_PAGE = process.env.E2E_FULL_PAGE === '1';

/**
 * Confirms the web app answers and that its CSP `connect-src` names the local API, which is the
 * only origin the browser may call, so every screenshot shows data from the local API.
 */
export const assertWebOnLocalApi = async (): Promise<void> => {
  let response: Response;
  try {
    response = await fetch(`${webOrigin}/wallet`, { redirect: 'manual' });
  } catch (cause) {
    throw new TargetError(
      'E2E_WEB_UNREACHABLE',
      `nothing answered at ${webOrigin} (${cause instanceof Error ? cause.message : String(cause)}). Start apps/web first.`,
    );
  }
  const policy = response.headers.get('content-security-policy') ?? '';
  const connect = policy
    .split(';')
    .map((directive) => directive.trim().split(/\s+/))
    .find(([name]) => name === 'connect-src');
  if (connect === undefined || !connect.includes(apiOrigin)) {
    throw new TargetError(
      'E2E_WEB_NOT_ON_LOCAL_API',
      `${webOrigin} does not allow ${apiOrigin} in connect-src (${connect?.join(' ') ?? 'no connect-src'}). Build apps/web with NEXT_PUBLIC_API_URL=${apiOrigin}.`,
    );
  }
};

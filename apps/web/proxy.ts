import { NextResponse, type NextRequest } from 'next/server';
import { publicEnv } from './lib/env/public';
import { appNetwork, browserSocketOrigins } from './lib/network';
import { buildContentSecurityPolicy } from './lib/security/csp';

const apiOrigin = new URL(publicEnv.apiUrl).origin;
const socketOrigins = browserSocketOrigins(appNetwork);

export function proxy(request: NextRequest): NextResponse {
  const nonce = btoa(crypto.randomUUID());
  const policy = buildContentSecurityPolicy({
    nonce,
    apiOrigin,
    socketOrigins,
    development: process.env.NODE_ENV === 'development',
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', policy);
  return response;
}

// `/recover` is left out: it serves the Recover file byte for byte with its own hash-based CSP, which
// the nonce policy here would replace and so block the file's inline script (recover.md).
export const config = {
  matcher: [
    {
      source: '/((?!_next/static|_next/image|icon.svg|apple-icon.png|recover$).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};

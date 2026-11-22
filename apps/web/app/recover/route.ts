import { publicEnv } from '@/lib/env/public';
import { loadRecoverFile, recoverHeaders } from './recover-file';

/**
 * `/recover` serves the standalone Recover file byte for byte (recover.md "Route and hosts"), outside
 * the app shell, with the file's own Content-Security-Policy. It is prerendered at build, so a missing
 * or altered file fails `next build` with a named error.
 */
export const dynamic = 'force-static';

export async function GET(): Promise<Response> {
  const file = await loadRecoverFile(publicEnv.network);
  return new Response(file.html, { status: 200, headers: recoverHeaders(file) });
}

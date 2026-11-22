import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Network } from '@atprice/core';
import { z } from 'zod';

/** Named failures of serving the Recover file; each fails `next build`, never a silent fallback. */
export class RecoverFileError extends Error {
  constructor(
    readonly code: 'RECOVER_FILE_MISSING' | 'RECOVER_MANIFEST_INVALID' | 'RECOVER_FILE_MISMATCH',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'RecoverFileError';
  }
}

const entrySchema = z.object({
  file: z.string().regex(/^atprice-recover-(mainnet|chipnet)-[0-9A-Za-z.-]+\.html$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().positive(),
  csp: z.string().startsWith("default-src 'none'"),
});

const manifestSchema = z.object({
  version: z.string(),
  files: z.object({ mainnet: entrySchema.optional(), chipnet: entrySchema.optional() }),
});

export interface RecoverFile {
  readonly html: Uint8Array<ArrayBuffer>;
  readonly sha256: string;
  readonly csp: string;
  readonly file: string;
}

/**
 * `apps/recover/dist`, built by `pnpm --filter @atprice/recover build` before the website. Read only
 * while `next build` prerenders `/recover`, so the server bundle needs no file tracing for it.
 */
export const RECOVER_DIST = join(/*turbopackIgnore: true*/ process.cwd(), '..', 'recover', 'dist');

/**
 * The Recover file for `network`, byte for byte as `apps/recover` built it, checked against the
 * SHA-256 in its manifest so the site can only serve the hash the README publishes (recover.md).
 */
export const loadRecoverFile = async (network: Network, dist: string = RECOVER_DIST): Promise<RecoverFile> => {
  let raw: string;
  try {
    raw = await readFile(join(/*turbopackIgnore: true*/ dist, 'manifest.json'), 'utf8');
  } catch (error) {
    throw new RecoverFileError(
      'RECOVER_FILE_MISSING',
      `no ${join(/*turbopackIgnore: true*/ dist, 'manifest.json')} (${error instanceof Error ? error.message : String(error)}); run pnpm --filter @atprice/recover build first`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new RecoverFileError('RECOVER_MANIFEST_INVALID', `manifest.json is not JSON: ${String(error)}`);
  }
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) throw new RecoverFileError('RECOVER_MANIFEST_INVALID', parsed.error.message);
  const entry = parsed.data.files[network];
  if (entry === undefined) {
    throw new RecoverFileError('RECOVER_FILE_MISSING', `the Recover build has no ${network} file; build it with ATPRICE_NETWORK=${network}`);
  }
  let html: Uint8Array<ArrayBuffer>;
  try {
    html = new Uint8Array(await readFile(join(/*turbopackIgnore: true*/ dist, entry.file)));
  } catch (error) {
    throw new RecoverFileError('RECOVER_FILE_MISSING', `${entry.file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const sha256 = createHash('sha256').update(html).digest('hex');
  if (sha256 !== entry.sha256) {
    throw new RecoverFileError('RECOVER_FILE_MISMATCH', `${entry.file} hashes to ${sha256}, the manifest says ${entry.sha256}`);
  }
  return { html, sha256, csp: entry.csp, file: entry.file };
};

/** The response headers `/recover` sends: the file's own CSP, plus its hash for anyone checking. */
export const recoverHeaders = (file: RecoverFile): Record<string, string> => ({
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': file.csp,
  'x-atprice-recover-sha256': file.sha256,
  'cache-control': 'public, max-age=300, must-revalidate',
});

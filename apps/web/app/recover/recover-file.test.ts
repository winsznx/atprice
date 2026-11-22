import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadRecoverFile, recoverHeaders } from './recover-file';

const HTML = '<!doctype html>\n<html lang="en"><body>recover</body></html>\n';
const CSP = "default-src 'none'; script-src 'sha256-x'";
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('loadRecoverFile', () => {
  let dist: string;

  beforeEach(async () => {
    dist = await mkdtemp(join(tmpdir(), 'recover-dist-'));
  });

  afterEach(async () => {
    await rm(dist, { recursive: true, force: true });
  });

  const writeManifest = async (sha256: string): Promise<void> => {
    await writeFile(join(dist, 'atprice-recover-chipnet-1.0.0.html'), HTML);
    await writeFile(
      join(dist, 'manifest.json'),
      JSON.stringify({
        version: '1.0.0',
        files: {
          chipnet: { file: 'atprice-recover-chipnet-1.0.0.html', sha256, bytes: HTML.length, csp: CSP },
        },
      }),
    );
  };

  it('serves the built bytes with the file CSP and hash', async () => {
    // #given a build whose manifest matches the file
    await writeManifest(sha(HTML));
    // #when the route loads it
    const file = await loadRecoverFile('chipnet', dist);
    // #then the bytes and headers are the build's own
    expect(new TextDecoder().decode(file.html)).toBe(HTML);
    expect(recoverHeaders(file)).toMatchObject({
      'content-security-policy': CSP,
      'x-atprice-recover-sha256': sha(HTML),
      link: '<https://atprice.cash/recover>; rel="canonical"',
    });
  });

  it('refuses a file that differs from the manifest hash', async () => {
    await writeManifest('0'.repeat(64));
    await expect(loadRecoverFile('chipnet', dist)).rejects.toThrow(/RECOVER_FILE_MISMATCH/);
  });

  it('names a missing build or network', async () => {
    await expect(loadRecoverFile('chipnet', dist)).rejects.toThrow(/RECOVER_FILE_MISSING/);
    await writeManifest(sha(HTML));
    await expect(loadRecoverFile('mainnet', dist)).rejects.toThrow(/RECOVER_FILE_MISSING/);
  });
});

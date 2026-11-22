import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';
import {
  animationViolations,
  contentSecurityPolicy,
  forbiddenInputs,
  missingZodMembers,
  optionalHttpsUrl,
  zodMembersUsed,
} from '../scripts/build-lib';
import { terminalQr } from '../src/cli/terminal-qr';
import { parseCliServer } from '../src/cli/args';
import { assertTemplateSafe } from '../src/shell/document';
import { readPrefill } from '../src/ui/app';

const root = fileURLToPath(new URL('..', import.meta.url));
const repo = join(root, '..', '..');

const parts = {
  title: 'Recover an order · AtPrice',
  csp: "default-src 'none'; connect-src wss:",
  icon: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
  css: 'body{margin:0}',
  js: 'console.log("recover")',
};

describe('template safety', () => {
  it('refuses parts that would change when parsed back', () => {
    expect(() => assertTemplateSafe({ ...parts, js: 'a="</script>"' })).toThrow(/RECOVER_TEMPLATE_UNSAFE/);
    expect(() => assertTemplateSafe({ ...parts, csp: 'a"b' })).toThrow(/RECOVER_TEMPLATE_UNSAFE/);
    expect(() => assertTemplateSafe({ ...parts, css: 'a</style>' })).toThrow(/RECOVER_TEMPLATE_UNSAFE/);
  });
});

describe('build checks', () => {
  it('keeps the bundle free of the API client and every AtPrice-host module (hard rule 1)', async () => {
    // #given the real browser entry, bundled the way scripts/build.ts bundles it
    const result = await esbuild.build({
      entryPoints: [join(root, 'src/browser/main.tsx')],
      bundle: true,
      write: false,
      metafile: true,
      format: 'esm',
      platform: 'browser',
      jsx: 'automatic',
      logLevel: 'silent',
      define: { __RECOVER_CONFIG__: '{}', 'process.env.NODE_ENV': '"production"' },
    });
    const inputs = Object.keys(result.metafile.inputs).map((input) => join(root, input).slice(repo.length + 1));
    // #then nothing from the web API layer, env or UI is in the graph
    expect(forbiddenInputs(inputs)).toEqual([]);
    expect(inputs.some((input) => input.startsWith('packages/core/'))).toBe(true);
  });

  it('flags an API module if one ever enters the graph', () => {
    expect(forbiddenInputs(['apps/web/lib/api/client.ts', 'apps/web/lib/format.ts'])).toEqual(['apps/web/lib/api/client.ts']);
  });

  it('fails when packages/chain calls a zod member the shim lacks', () => {
    expect(zodMembersUsed('z.object({ a: z.string() }); z.literal(1)')).toEqual(['object', 'string', 'literal']);
    expect(missingZodMembers(['z.object(); z.literal(1)'])).toEqual(['literal']);
    expect(missingZodMembers(['z.object(); z.array(z.number())'])).toEqual([]);
  });

  it('finds keyframes and animate utilities in the stylesheet', () => {
    expect(animationViolations('.a{color:red}')).toEqual([]);
    expect(animationViolations('@keyframes spin{}.animate-spin{animation:spin}')).toEqual(['@keyframes', '.animate-spin']);
  });

  it('limits scripts and styles to the inlined hashes', () => {
    const csp = contentSecurityPolicy('body{}', 'run()');
    expect(csp).toMatch(/^default-src 'none'; script-src 'sha256-[A-Za-z0-9+/=]+' 'wasm-unsafe-eval'; style-src 'sha256-/);
    expect(csp).toContain('connect-src wss:');
    expect(csp).not.toContain('unsafe-inline');
  });

  it('accepts only https links from build config and leaves blank ones out', () => {
    expect(optionalHttpsUrl('ATPRICE_RECOVER_WEBSITE_URL', ' ')).toBeNull();
    expect(optionalHttpsUrl('ATPRICE_RECOVER_WEBSITE_URL', 'https://atprice.example/')).toBe('https://atprice.example/');
    expect(() => optionalHttpsUrl('ATPRICE_RECOVER_WEBSITE_URL', 'http://atprice.example')).toThrow(
      /ATPRICE_RECOVER_WEBSITE_URL_INVALID/,
    );
  });
});

describe('CLI helpers', () => {
  it('reads TLS and WebSocket servers', () => {
    expect(parseCliServer('chipnet.imaginary.cash:50002')).toEqual({ host: 'chipnet.imaginary.cash', port: 50002, transport: 'tls' });
    expect(parseCliServer('wss://chipnet.imaginary.cash:50004')).toEqual({
      host: 'chipnet.imaginary.cash',
      port: 50004,
      transport: 'wss',
    });
    expect(() => parseCliServer('chipnet.imaginary.cash')).toThrow(/host:port/);
  });

  it('draws a square terminal QR with two module rows per line', () => {
    const lines = terminalQr('WIZ://TEST').split('\n');
    const width = lines[0]?.length ?? 0;
    expect(lines.every((line) => line.length === width)).toBe(true);
    expect(lines.length).toBe(Math.ceil(width / 2));
  });
});

describe('prefill', () => {
  it('reads ?txid= before ?address=', () => {
    expect(readPrefill('?txid=ab&address=x')).toEqual({ mode: 'txid', value: 'ab' });
    expect(readPrefill('?address=bchtest:qq')).toEqual({ mode: 'address', value: 'bchtest:qq' });
    expect(readPrefill('')).toBeNull();
  });
});

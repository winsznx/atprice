/**
 * Builds AtPrice Recover: one self-contained HTML file per network (recover.md "Shell"), plus
 * `dist/manifest.json`, which the website's `/recover` route reads to serve the same bytes.
 *
 *   pnpm --filter @atprice/recover build            both networks
 *   ATPRICE_NETWORK=chipnet pnpm ... build          one network
 *   ATPRICE_RECOVER_WEBSITE_URL, ATPRICE_RECOVER_SOURCE_URL   optional https links
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import * as esbuild from 'esbuild';
import postcss from 'postcss';
import subsetFont from 'subset-font';
import type { Network } from '@atprice/core';
import type { RecoverConfig } from '../src/config';
import { assertTemplateSafe, renderRecoverDocument, sha256Hex } from '../src/shell/document';
import {
  animationViolations,
  BuildConfigError,
  contentSecurityPolicy,
  FILE_BUDGET_BYTES,
  FONT_BUDGET_BYTES,
  FONT_SUBSET_TEXT,
  forbiddenInputs,
  missingZodMembers,
  optionalHttpsUrl,
  ZOD_SHIM_MEMBERS,
} from './build-lib';

const root = fileURLToPath(new URL('..', import.meta.url));
const repo = join(root, '..', '..');
const dist = join(root, 'dist');
const require = createRequire(import.meta.url);

const NETWORKS: readonly Network[] = ['chipnet', 'mainnet'];

const networksToBuild = (): readonly Network[] => {
  const value = process.env.ATPRICE_NETWORK?.trim() ?? '';
  if (value === '') return NETWORKS;
  if (value === 'mainnet' || value === 'chipnet') return [value];
  throw new BuildConfigError(
    'ATPRICE_NETWORK_INVALID',
    `ATPRICE_NETWORK must be mainnet or chipnet, got ${value}`,
  );
};

const FONT_FEATURES = ['kern', 'tnum', 'lnum', 'ccmp', 'locl', 'calt', 'liga', 'mark', 'mkmk'];

interface FontFace {
  readonly family: string;
  readonly weight: number;
  readonly file: string;
}

const FACES: readonly FontFace[] = [
  { family: 'Inter', weight: 400, file: '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2' },
  { family: 'Inter', weight: 600, file: '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2' },
  {
    family: 'JetBrains Mono',
    weight: 400,
    file: '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2',
  },
];

/** Subset and instanced woff2 faces as data URIs, `font-display: block` (recover.md Fonts row). */
const buildFontFaces = async (): Promise<{ css: string; base64Bytes: number }> => {
  let base64Bytes = 0;
  const rules: string[] = [];
  for (const face of FACES) {
    const source = await readFile(require.resolve(face.file));
    const subset = await subsetFont(source, FONT_SUBSET_TEXT, {
      targetFormat: 'woff2',
      variationAxes: { wght: face.weight },
      keepFeatures: FONT_FEATURES,
    });
    const base64 = subset.toString('base64');
    base64Bytes += base64.length;
    rules.push(
      `@font-face{font-family:'${face.family}';font-style:normal;font-weight:${face.weight};font-display:block;src:url(data:font/woff2;base64,${base64}) format('woff2')}`,
    );
  }
  if (base64Bytes > FONT_BUDGET_BYTES) {
    throw new BuildConfigError(
      'RECOVER_FONT_BUDGET',
      `fonts take ${base64Bytes} bytes, budget ${FONT_BUDGET_BYTES}`,
    );
  }
  return { css: rules.join(''), base64Bytes };
};

const buildCss = async (fontCss: string): Promise<string> => {
  const input = join(root, 'src/browser/styles.css');
  const result = await postcss([tailwind({ base: join(root, 'src'), optimize: { minify: true } })]).process(
    await readFile(input, 'utf8'),
    { from: input },
  );
  const css = `${fontCss}${result.css.trim()}`;
  const violations = animationViolations(css);
  if (violations.length > 0) {
    throw new BuildConfigError('RECOVER_CSS_ANIMATION', `the stylesheet animates: ${violations.join(', ')}`);
  }
  return css;
};

/**
 * `packages/chain` imports `{ z } from 'zod'`, which keeps all of zod's namespace (about 440 KB) in a
 * bundle. The file routes those imports to a shim built from zod's own tree-shakable named exports,
 * and the build fails if chain ever calls a `z.*` member the shim doesn't provide.
 */
const zodShimPlugin = async (): Promise<esbuild.Plugin> => {
  const chainDist = join(repo, 'packages/chain/dist');
  const sources = await Promise.all(
    ['electrum.js', 'broadcast.js', 'rostrum.js', 'cauldron-indexer.js'].map((file) =>
      readFile(join(chainDist, file), 'utf8'),
    ),
  );
  const missing = missingZodMembers(sources);
  if (missing.length > 0) {
    throw new BuildConfigError(
      'RECOVER_ZOD_SHIM',
      `packages/chain uses z.${missing.join(', z.')}, add them to the shim`,
    );
  }
  const shimPath = join(root, 'src/browser/zod-shim.virtual.ts');
  const shimSource = `import { ${ZOD_SHIM_MEMBERS.map((member) => (member === 'enum' ? 'enum as zodEnum' : member)).join(', ')} } from 'zod';\nexport const z = { ${ZOD_SHIM_MEMBERS.map((member) => (member === 'enum' ? 'enum: zodEnum' : member)).join(', ')} };\n`;
  return {
    name: 'atprice-zod-shim',
    setup(build) {
      build.onResolve({ filter: /^zod$/ }, (args) => {
        if (args.pluginData === 'real') return undefined;
        if (args.importer === shimPath) {
          return build.resolve('zod', {
            resolveDir: join(repo, 'packages/chain'),
            kind: args.kind,
            pluginData: 'real',
          });
        }
        return { path: shimPath, namespace: 'atprice-zod-shim' };
      });
      build.onLoad({ filter: /.*/, namespace: 'atprice-zod-shim' }, () => ({
        contents: shimSource,
        loader: 'ts',
        resolveDir: join(root, 'src/browser'),
      }));
    },
  };
};

const buildJs = async (config: RecoverConfig, plugin: esbuild.Plugin): Promise<string> => {
  const result = await esbuild.build({
    entryPoints: [join(root, 'src/browser/main.tsx')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    charset: 'ascii',
    legalComments: 'eof',
    jsx: 'automatic',
    metafile: true,
    logLevel: 'warning',
    define: {
      __RECOVER_CONFIG__: JSON.stringify(config),
      'process.env.NODE_ENV': '"production"',
    },
    plugins: [plugin],
  });
  const inputs = Object.keys(result.metafile.inputs).map((input) => relative(repo, join(root, input)));
  const forbidden = forbiddenInputs(inputs);
  if (forbidden.length > 0) {
    throw new BuildConfigError('RECOVER_FORBIDDEN_MODULE', `the bundle includes ${forbidden.join(', ')}`);
  }
  const output = result.outputFiles[0];
  if (output === undefined) throw new BuildConfigError('RECOVER_BUNDLE_EMPTY', 'esbuild produced no output');
  return output.text.trim();
};

const iconDataUri = async (): Promise<string> => {
  const svg = await readFile(join(repo, 'apps/web/app/icon.svg'));
  return `data:image/svg+xml;base64,${svg.toString('base64')}`;
};

interface ManifestEntry {
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly csp: string;
}

const main = async (): Promise<void> => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string };
  const websiteUrl = optionalHttpsUrl('ATPRICE_RECOVER_WEBSITE_URL', process.env.ATPRICE_RECOVER_WEBSITE_URL);
  const sourceUrl = optionalHttpsUrl('ATPRICE_RECOVER_SOURCE_URL', process.env.ATPRICE_RECOVER_SOURCE_URL);
  const networks = networksToBuild();
  const [fonts, plugin, icon] = await Promise.all([buildFontFaces(), zodShimPlugin(), iconDataUri()]);
  const css = await buildCss(fonts.css);
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  const manifest: { version: string; files: Partial<Record<Network, ManifestEntry>> } = {
    version: pkg.version,
    files: {},
  };
  for (const network of networks) {
    const config: RecoverConfig = { network, version: pkg.version, websiteUrl, sourceUrl };
    const js = await buildJs(config, plugin);
    const csp = contentSecurityPolicy(css, js);
    const parts = { title: 'Recover an order · AtPrice', csp, icon, css, js };
    assertTemplateSafe(parts);
    const html = renderRecoverDocument(parts);
    const bytes = Buffer.byteLength(html, 'utf8');
    if (bytes > FILE_BUDGET_BYTES) {
      throw new BuildConfigError(
        'RECOVER_FILE_BUDGET',
        `${network} file is ${bytes} bytes, budget ${FILE_BUDGET_BYTES}`,
      );
    }
    const file = `atprice-recover-${network}-${pkg.version}.html`;
    await writeFile(join(dist, file), html, 'utf8');
    const sha256 = sha256Hex(html);
    manifest.files[network] = { file, sha256, bytes, csp };
    console.log(
      `${file}  ${(bytes / 1024).toFixed(1)} KB (fonts ${(fonts.base64Bytes / 1024).toFixed(1)} KB, css ${(css.length / 1024).toFixed(1)} KB, js ${(js.length / 1024).toFixed(1)} KB)`,
    );
    console.log(`SHA-256 ${sha256}  ${file}`);
  }
  await writeFile(join(dist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${relative(repo, join(dist, 'manifest.json'))}`);
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

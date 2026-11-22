import { createHash } from 'node:crypto';

/** recover.md "Shell": CI fails above these. */
export const FILE_BUDGET_BYTES = 1_500 * 1024;
export const FONT_BUDGET_BYTES = 80 * 1024;

/**
 * Basic Latin plus the characters recover.md lists for the font subset. A glyph the source font
 * doesn't have is skipped by the subsetter and falls back to the DD 9 stack.
 */
export const FONT_SUBSET_TEXT =
  Array.from({ length: 0x7e - 0x20 + 1 }, (_, index) => String.fromCharCode(0x20 + index)).join('') +
  '−…·→⇄≈';

/** The `z.*` members the zod shim provides to `packages/chain` (see `zodShimPlugin` in build.ts). */
export const ZOD_SHIM_MEMBERS = ['array', 'bigint', 'boolean', 'enum', 'number', 'object', 'string', 'union'] as const;

/** Every `z.member` a module calls, so the build fails if `packages/chain` starts using one the shim lacks. */
export const zodMembersUsed = (source: string): string[] => [
  ...new Set([...source.matchAll(/\bz\.([A-Za-z]+)\b/g)].map((match) => match[1] ?? '')),
];

export const missingZodMembers = (sources: readonly string[]): string[] => {
  const provided = new Set<string>(ZOD_SHIM_MEMBERS);
  return [...new Set(sources.flatMap(zodMembersUsed))].filter((member) => !provided.has(member)).sort();
};

/**
 * recover.md hard rule 1: the file bundles no API client. Any module from the web app's API layer, its
 * env (which carries the API URL) or its UI fails the build.
 */
export const FORBIDDEN_MODULES: readonly RegExp[] = [
  /apps\/web\/lib\/api\//,
  /apps\/web\/lib\/env\//,
  /apps\/web\/lib\/network\.ts$/,
  /apps\/web\/lib\/notifications\//,
  /apps\/web\/components\//,
  /apps\/web\/app\//,
  /apps\/server\//,
  /node_modules\/(@tanstack|sonner|radix-ui|@radix-ui|next)\//,
];

export const forbiddenInputs = (inputs: readonly string[]): string[] =>
  inputs.filter((input) => FORBIDDEN_MODULES.some((pattern) => pattern.test(input)));

/** recover.md "Shell", Motion row: nothing in the file animates with keyframes. */
export const animationViolations = (css: string): string[] => {
  const found: string[] = [];
  if (/@keyframes/.test(css)) found.push('@keyframes');
  const animate = css.match(/\.animate-[\w-]+/g);
  if (animate !== null) found.push(...new Set(animate));
  return found;
};

/** CSP source for an inline element: base64 SHA-256 of its exact text. */
export const cspHash = (text: string): string => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

export const contentSecurityPolicy = (css: string, js: string): string =>
  [
    "default-src 'none'",
    // libauth compiles its secp256k1 and hash WebAssembly at load; this allows only that, never eval().
    `script-src ${cspHash(js)} 'wasm-unsafe-eval'`,
    `style-src ${cspHash(css)}`,
    'font-src data:',
    'img-src data:',
    'connect-src wss:',
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

export class BuildConfigError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'BuildConfigError';
  }
}

/** An optional absolute `https://` URL from build config; blank means "leave the link out". */
export const optionalHttpsUrl = (name: string, value: string | undefined): string | null => {
  const trimmed = value?.trim() ?? '';
  if (trimmed === '') return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new BuildConfigError(`${name}_INVALID`, `${name} is not a URL: ${trimmed}`);
  }
  if (url.protocol !== 'https:') throw new BuildConfigError(`${name}_INVALID`, `${name} must start with https://`);
  if (/[<>&"]/.test(url.href)) throw new BuildConfigError(`${name}_INVALID`, `${name} contains < > & or "`);
  return url.href;
};

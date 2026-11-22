export interface CspInput {
  readonly nonce: string;
  readonly apiOrigin: string;
  readonly socketOrigins: readonly string[];
  readonly development: boolean;
}

/**
 * The page's Content-Security-Policy. Scripts run only with this request's nonce (Next stamps it on
 * its own inline scripts); `wasm-unsafe-eval` lets libauth instantiate its secp256k1 and hash
 * WebAssembly, and nothing else is evaluated. Styles allow inline because React server-renders
 * `style` attributes (Radix positioning) and Sonner inserts its stylesheet at runtime; a style can't
 * run code or reach the network under this policy. Development adds `unsafe-eval` for React's
 * debugging stack reconstruction and the dev server's websocket.
 */
export const buildContentSecurityPolicy = ({
  nonce,
  apiOrigin,
  socketOrigins,
  development,
}: CspInput): string => {
  const scriptSrc = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", "'wasm-unsafe-eval'"];
  if (development) scriptSrc.push("'unsafe-eval'");
  const connectSrc = ["'self'", apiOrigin, ...socketOrigins];
  if (development) connectSrc.push('ws://localhost:*', 'ws://127.0.0.1:*');
  const directives: [string, string[]][] = [
    ['default-src', ["'self'"]],
    ['script-src', scriptSrc],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:', 'blob:']],
    ['font-src', ["'self'"]],
    ['connect-src', connectSrc],
    ['worker-src', ["'self'", 'blob:']],
    ['manifest-src', ["'self'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
    ['frame-src', ["'none'"]],
    ['frame-ancestors', ["'none'"]],
  ];
  const policy = directives.map(([name, values]) => `${name} ${values.join(' ')}`);
  if (!development) policy.push('upgrade-insecure-requests');
  return policy.join('; ');
};

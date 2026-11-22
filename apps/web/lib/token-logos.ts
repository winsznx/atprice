/**
 * DD 12 asset logos. Each file is the official logo vendored byte for byte from
 * internal/design/assets/tokens (provenance in SOURCES.md there) and served by this app, so the CSP
 * keeps `img-src 'self'`. The UI never builds a logo URL from token metadata at runtime: an asset
 * missing from this map gets the monogram fallback in `TokenLogo`.
 */

/** Native BCH has no token category; it uses this key and `public/tokens/bch.svg`. */
export const BCH_ASSET = 'bch';

const VENDORED = [
  BCH_ASSET,
  // PUSD, mainnet
  '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544',
  // RES, mainnet
  '5e4a058f6593be30090ce6e03282ab0a85ad393275f246c2fb34fae15da017da',
  // PUSDTEST, chipnet
  'dfe50223c8d5cba8dcef8dff6d92b61deb88a8ba44947367f2b746487b56039b',
] as const;

const LOGO_SRC: ReadonlyMap<string, string> = new Map(
  VENDORED.map((asset) => [asset, `/tokens/${asset}.svg`]),
);

/** The vendored logo path for a token category (or `BCH_ASSET`), or `undefined` when there is none. */
export const tokenLogoSrc = (asset: string): string | undefined => LOGO_SRC.get(asset);

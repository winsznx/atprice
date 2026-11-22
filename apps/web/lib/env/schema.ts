import { decodeCashAddress } from '@bitauth/libauth';
import type { Network } from '@atprice/core';
import { EnvError, type EnvErrorCode } from './errors';

/** Raw `process.env` values. Each key is read with a literal `process.env.X` so Next inlines it. */
export interface RawPublicEnv {
  readonly NEXT_PUBLIC_ATPRICE_NETWORK: string | undefined;
  readonly NEXT_PUBLIC_API_URL: string | undefined;
  readonly NEXT_PUBLIC_BUILD_SHA: string | undefined;
  readonly NEXT_PUBLIC_BLAZE_DECK_URL: string | undefined;
  readonly NEXT_PUBLIC_SOURCE_REPO_URL: string | undefined;
  readonly NEXT_PUBLIC_EMBER_ADDRESS: string | undefined;
}

/**
 * A banner value is either published or explicitly not yet published. Only these BLAZE banner
 * fields may render "not yet published" (DD 7.14); every other variable is required.
 */
export type BannerValue =
  { readonly published: true; readonly value: string } | { readonly published: false };

export interface BlazeBannerConfig {
  readonly deckUrl: BannerValue;
  readonly sourceRepoUrl: BannerValue;
  readonly emberAddress: BannerValue;
}

export interface PublicEnv {
  readonly network: Network;
  /** API origin plus optional base path, without a trailing slash. The client appends `/api/v1`. */
  readonly apiUrl: string;
  readonly buildSha: string;
  readonly banner: BlazeBannerConfig;
}

const blank = (value: string | undefined): value is undefined => value === undefined || value.trim() === '';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const parseApiUrl = (raw: string | undefined): string => {
  if (blank(raw)) throw new EnvError('ENV_API_URL_MISSING', 'NEXT_PUBLIC_API_URL', 'is not set');
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new EnvError('ENV_API_URL_INVALID', 'NEXT_PUBLIC_API_URL', `is not a URL: ${raw}`);
  }
  const plainLocal = url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !plainLocal) {
    throw new EnvError(
      'ENV_API_URL_INVALID',
      'NEXT_PUBLIC_API_URL',
      'must use https (http only for localhost)',
    );
  }
  if (url.search !== '' || url.hash !== '') {
    throw new EnvError('ENV_API_URL_INVALID', 'NEXT_PUBLIC_API_URL', 'must not carry a query or fragment');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
};

const parseNetwork = (raw: string | undefined): Network => {
  if (blank(raw)) throw new EnvError('ENV_NETWORK_MISSING', 'NEXT_PUBLIC_ATPRICE_NETWORK', 'is not set');
  const value = raw.trim();
  if (value !== 'mainnet' && value !== 'chipnet') {
    throw new EnvError(
      'ENV_NETWORK_INVALID',
      'NEXT_PUBLIC_ATPRICE_NETWORK',
      `must be "mainnet" or "chipnet", got "${value}"`,
    );
  }
  return value;
};

const parseBannerUrl = (raw: string | undefined, code: EnvErrorCode, variable: string): BannerValue => {
  if (blank(raw)) return { published: false };
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new EnvError(code, variable, `is not a URL: ${raw}`);
  }
  if (url.protocol !== 'https:') throw new EnvError(code, variable, 'must be an https:// URL');
  return { published: true, value: url.toString() };
};

const TOKEN_AWARE_TYPES = new Set(['p2pkhWithTokens', 'p2shWithTokens']);

/** EMBER2026 receives on mainnet whatever the app network is, so it must be a mainnet token-aware address. */
const parseEmberAddress = (raw: string | undefined): BannerValue => {
  if (blank(raw)) return { published: false };
  const value = raw.trim();
  const decoded = decodeCashAddress(value);
  if (typeof decoded === 'string') {
    throw new EnvError(
      'BLAZE_EMBER_ADDRESS_INVALID',
      'NEXT_PUBLIC_EMBER_ADDRESS',
      `is not a CashAddress: ${decoded}`,
    );
  }
  if (decoded.prefix !== 'bitcoincash' || !TOKEN_AWARE_TYPES.has(decoded.type)) {
    throw new EnvError(
      'BLAZE_EMBER_ADDRESS_INVALID',
      'NEXT_PUBLIC_EMBER_ADDRESS',
      'must be a mainnet token-aware address (bitcoincash:z...)',
    );
  }
  return { published: true, value: value.startsWith('bitcoincash:') ? value : `bitcoincash:${value}` };
};

export const validatePublicEnv = (raw: RawPublicEnv): PublicEnv => {
  const buildSha = raw.NEXT_PUBLIC_BUILD_SHA;
  if (blank(buildSha)) throw new EnvError('ENV_BUILD_SHA_MISSING', 'NEXT_PUBLIC_BUILD_SHA', 'is not set');
  return {
    network: parseNetwork(raw.NEXT_PUBLIC_ATPRICE_NETWORK),
    apiUrl: parseApiUrl(raw.NEXT_PUBLIC_API_URL),
    buildSha: buildSha.trim(),
    banner: {
      deckUrl: parseBannerUrl(
        raw.NEXT_PUBLIC_BLAZE_DECK_URL,
        'BLAZE_DECK_URL_INVALID',
        'NEXT_PUBLIC_BLAZE_DECK_URL',
      ),
      sourceRepoUrl: parseBannerUrl(
        raw.NEXT_PUBLIC_SOURCE_REPO_URL,
        'BLAZE_SOURCE_REPO_URL_INVALID',
        'NEXT_PUBLIC_SOURCE_REPO_URL',
      ),
      emberAddress: parseEmberAddress(raw.NEXT_PUBLIC_EMBER_ADDRESS),
    },
  };
};

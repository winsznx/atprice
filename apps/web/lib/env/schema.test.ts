import { describe, expect, it } from 'vitest';
import { EnvError } from './errors';
import { validatePublicEnv, type RawPublicEnv } from './schema';

const BASE: RawPublicEnv = {
  NEXT_PUBLIC_ATPRICE_NETWORK: 'chipnet',
  NEXT_PUBLIC_API_URL: 'https://api.example.org/',
  NEXT_PUBLIC_BUILD_SHA: 'abc1234',
  NEXT_PUBLIC_BLAZE_DECK_URL: undefined,
  NEXT_PUBLIC_SOURCE_REPO_URL: undefined,
  NEXT_PUBLIC_EMBER_ADDRESS: undefined,
};

const codeOf = (raw: RawPublicEnv): string => {
  try {
    validatePublicEnv(raw);
  } catch (error) {
    if (error instanceof EnvError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
};

describe('public env', () => {
  it('accepts a minimal config and renders every banner field as not yet published', () => {
    const env = validatePublicEnv(BASE);
    expect(env.apiUrl).toBe('https://api.example.org');
    expect(Object.values(env.banner).every((value) => !value.published)).toBe(true);
  });

  it('names every missing or invalid required variable', () => {
    expect(codeOf({ ...BASE, NEXT_PUBLIC_ATPRICE_NETWORK: undefined })).toBe('ENV_NETWORK_MISSING');
    expect(codeOf({ ...BASE, NEXT_PUBLIC_ATPRICE_NETWORK: 'testnet4' })).toBe('ENV_NETWORK_INVALID');
    expect(codeOf({ ...BASE, NEXT_PUBLIC_API_URL: ' ' })).toBe('ENV_API_URL_MISSING');
    expect(codeOf({ ...BASE, NEXT_PUBLIC_API_URL: 'http://api.example.org' })).toBe('ENV_API_URL_INVALID');
    expect(codeOf({ ...BASE, NEXT_PUBLIC_BUILD_SHA: '' })).toBe('ENV_BUILD_SHA_MISSING');
  });

  it('allows plain http only for localhost', () => {
    expect(validatePublicEnv({ ...BASE, NEXT_PUBLIC_API_URL: 'http://localhost:4000' }).apiUrl).toBe(
      'http://localhost:4000',
    );
  });

  it('fails the build on an invalid banner value instead of hiding it', () => {
    expect(codeOf({ ...BASE, NEXT_PUBLIC_BLAZE_DECK_URL: 'http://deck.example.org' })).toBe(
      'BLAZE_DECK_URL_INVALID',
    );
    expect(codeOf({ ...BASE, NEXT_PUBLIC_EMBER_ADDRESS: 'not-an-address' })).toBe(
      'BLAZE_EMBER_ADDRESS_INVALID',
    );
  });
});

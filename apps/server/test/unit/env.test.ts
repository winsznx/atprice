import { describe, expect, it } from 'vitest';
import { CHAIN_NETWORKS } from '@atprice/chain';
import {
  EnvValidationError,
  MIN_DISTINCT_ELECTRUM_HOSTS,
  distinctHosts,
  loadApiEnv,
  loadKeeperEnv,
  loadMigrateEnv,
} from '../../src/env.js';

const API_ENV = {
  ATPRICE_NETWORK: 'chipnet',
  DATABASE_URL: 'postgres://mac@/atprice_chipnet?host=/tmp',
  API_PORT: '4000',
  WEB_ORIGIN: 'https://atprice.example',
  TRUST_PROXY: '172.20.0.2',
};

const issueCodes = (load: () => unknown): string[] => {
  try {
    load();
  } catch (error) {
    if (error instanceof EnvValidationError) return error.issues.map((issue) => issue.code);
    throw error;
  }
  throw new Error('expected an EnvValidationError');
};

describe('environment validation', () => {
  it('names every missing required variable of the api process at once', () => {
    expect(issueCodes(() => loadApiEnv({}))).toEqual([
      'ENV_MISSING_ATPRICE_NETWORK',
      'ENV_MISSING_DATABASE_URL',
      'ENV_MISSING_API_PORT',
      'ENV_MISSING_WEB_ORIGIN',
      'ENV_MISSING_TRUST_PROXY',
    ]);
  });

  it('needs only the network and database for the keeper, and only the database for migrate', () => {
    expect(issueCodes(() => loadKeeperEnv({}))).toEqual([
      'ENV_MISSING_ATPRICE_NETWORK',
      'ENV_MISSING_DATABASE_URL',
    ]);
    expect(issueCodes(() => loadMigrateEnv({}))).toEqual(['ENV_MISSING_DATABASE_URL']);
  });

  it.each([
    ['ATPRICE_NETWORK', 'testnet4'],
    ['DATABASE_URL', 'mysql://localhost/x'],
    ['API_PORT', '70000'],
    ['WEB_ORIGIN', 'https://atprice.example/path'],
    ['TRUST_PROXY', 'everyone'],
    ['KEEPER_SWEEP_INTERVAL_MS', '100'],
    ['HEALTH_EVAL_INTERVAL_MS', 'soon'],
    ['ELECTRUM_SERVERS', 'chipnet.imaginary.cash'],
    ['ELECTRUM_SERVERS', 'chipnet.imaginary.cash:50002'],
    ['ELECTRUM_SERVERS', 'chipnet.imaginary.cash:50002,CHIPNET.imaginary.cash:50004'],
    ['ATPRICE_COHORT', 'judges'],
    ['LOG_LEVEL', 'verbose'],
  ])('rejects an invalid %s with a named error', (variable, value) => {
    expect(issueCodes(() => loadApiEnv({ ...API_ENV, [variable]: value }))).toEqual([
      `ENV_INVALID_${variable}`,
    ]);
  });

  it('treats a blank value as missing', () => {
    expect(issueCodes(() => loadApiEnv({ ...API_ENV, WEB_ORIGIN: '   ' }))).toEqual([
      'ENV_MISSING_WEB_ORIGIN',
    ]);
  });

  it('parses a complete api environment with defaults for the optional variables', () => {
    const env = loadApiEnv(API_ENV);
    expect(env).toMatchObject({
      network: 'chipnet',
      apiPort: 4000,
      apiHost: '0.0.0.0',
      webOrigin: 'https://atprice.example',
      trustProxy: ['172.20.0.2'],
      sweepIntervalMs: 30_000,
      healthEvalIntervalMs: 30_000,
      electrumServers: null,
      cohort: 'developer_test',
      logLevel: 'info',
    });
  });

  it('reads the trust proxy setting as none, a hop count, or proxy addresses', () => {
    expect(loadApiEnv({ ...API_ENV, TRUST_PROXY: 'none' }).trustProxy).toBe(false);
    expect(loadApiEnv({ ...API_ENV, TRUST_PROXY: '1' }).trustProxy).toBe(1);
    expect(loadApiEnv({ ...API_ENV, TRUST_PROXY: '10.0.0.0/8, ::1' }).trustProxy).toEqual([
      '10.0.0.0/8',
      '::1',
    ]);
  });

  it('ships at least two distinct Electrum hosts per network, so the evaluator can be independent', () => {
    for (const network of ['chipnet', 'mainnet'] as const) {
      expect(distinctHosts(CHAIN_NETWORKS[network].nodeElectrum)).toBeGreaterThanOrEqual(
        MIN_DISTINCT_ELECTRUM_HOSTS,
      );
    }
  });

  it('replaces the built-in Electrum list with ELECTRUM_SERVERS as TLS endpoints', () => {
    const env = loadKeeperEnv({
      ...API_ENV,
      ELECTRUM_SERVERS: 'chipnet.bch.ninja:50002,chipnet.c3-soft.com:64002',
    });
    expect(env.electrumServers).toEqual([
      { host: 'chipnet.bch.ninja', port: 50002, transport: 'tls' },
      { host: 'chipnet.c3-soft.com', port: 64002, transport: 'tls' },
    ]);
  });
});

import { parseElectrumEndpoints, type ElectrumEndpoint } from '@atprice/chain';
import type { Network } from '@atprice/core';

export type EnvIssueKind = 'missing' | 'invalid';

/** One problem with one variable, with a stable code such as `ENV_MISSING_DATABASE_URL`. */
export interface EnvIssue {
  readonly variable: string;
  readonly kind: EnvIssueKind;
  readonly code: string;
  readonly message: string;
}

export class EnvValidationError extends Error {
  constructor(readonly issues: readonly EnvIssue[]) {
    super(`invalid environment:\n${issues.map((issue) => `  ${issue.code}: ${issue.message}`).join('\n')}`);
    this.name = 'EnvValidationError';
  }
}

export type Cohort = 'developer_test' | 'pilot' | 'production';

/** `false` trusts no proxy; otherwise a hop count or the proxy addresses Fastify should trust. */
export type TrustProxy = false | number | readonly string[];

export interface CommonEnv {
  readonly network: Network;
  readonly databaseUrl: string;
  readonly electrumServers: readonly ElectrumEndpoint[] | null;
  readonly sweepIntervalMs: number;
  readonly cohort: Cohort;
  readonly logLevel: string;
}

export interface ApiEnv extends CommonEnv {
  readonly apiPort: number;
  readonly apiHost: string;
  readonly webOrigin: string;
  readonly trustProxy: TrustProxy;
  readonly healthEvalIntervalMs: number;
}

export type KeeperEnv = CommonEnv;

type Source = Readonly<Record<string, string | undefined>>;

class Reader {
  readonly issues: EnvIssue[] = [];
  constructor(private readonly source: Source) {}

  private issue(variable: string, kind: EnvIssueKind, message: string): void {
    this.issues.push({ variable, kind, code: `ENV_${kind.toUpperCase()}_${variable}`, message });
  }

  raw(variable: string): string | undefined {
    const value = this.source[variable]?.trim();
    return value === undefined || value === '' ? undefined : value;
  }

  required<T>(variable: string, parse: (value: string) => T | undefined, expected: string): T | undefined {
    const value = this.raw(variable);
    if (value === undefined) {
      this.issue(variable, 'missing', `${variable} is required (${expected})`);
      return undefined;
    }
    return this.parsed(variable, value, parse, expected);
  }

  optional<T>(variable: string, parse: (value: string) => T | undefined, expected: string, fallback: T): T {
    const value = this.raw(variable);
    if (value === undefined) return fallback;
    return this.parsed(variable, value, parse, expected) ?? fallback;
  }

  private parsed<T>(
    variable: string,
    value: string,
    parse: (value: string) => T | undefined,
    expected: string,
  ): T | undefined {
    let result: T | undefined;
    try {
      result = parse(value);
    } catch (error) {
      this.issue(
        variable,
        'invalid',
        `${variable} is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
    if (result === undefined)
      this.issue(variable, 'invalid', `${variable} must be ${expected}, got "${value}"`);
    return result;
  }
}

const parseNetwork = (value: string): Network | undefined =>
  value === 'chipnet' || value === 'mainnet' ? value : undefined;

const parsePostgresUrl = (value: string): string | undefined =>
  /^postgres(ql)?:\/\//.test(value) ? value : undefined;

const parseIntIn =
  (min: number, max: number) =>
  (value: string): number | undefined => {
    if (!/^\d+$/.test(value)) return undefined;
    const number = Number(value);
    return number >= min && number <= max ? number : undefined;
  };

const parseOrigin = (value: string): string | undefined => {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    return url.origin === value.replace(/\/$/, '') ? url.origin : undefined;
  } catch {
    return undefined;
  }
};

const IP_OR_CIDR = /^[0-9a-f:.]+(\/\d{1,3})?$/i;

const parseTrustProxy = (value: string): TrustProxy | undefined => {
  if (value === 'none') return false;
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    return hops >= 1 && hops <= 5 ? hops : undefined;
  }
  const entries = value.split(',').map((entry) => entry.trim());
  return entries.length > 0 && entries.every((entry) => IP_OR_CIDR.test(entry)) ? entries : undefined;
};

const parseCohort = (value: string): Cohort | undefined =>
  value === 'developer_test' || value === 'pilot' || value === 'production' ? value : undefined;

const parseLogLevel = (value: string): string | undefined =>
  ['fatal', 'error', 'warn', 'info', 'debug', 'trace'].includes(value) ? value : undefined;

/** Distinct hosts an Electrum list needs: the health evaluator must read a server the keeper does not. */
export const MIN_DISTINCT_ELECTRUM_HOSTS = 2;

export const distinctHosts = (endpoints: readonly ElectrumEndpoint[]): number =>
  new Set(endpoints.map((endpoint) => endpoint.host.toLowerCase())).size;

const parseServers = (value: string): ElectrumEndpoint[] | undefined => {
  const servers = parseElectrumEndpoints(value, 'tls');
  if (servers.length === 0) return undefined;
  if (distinctHosts(servers) < MIN_DISTINCT_ELECTRUM_HOSTS) {
    throw new Error(
      `list at least ${MIN_DISTINCT_ELECTRUM_HOSTS} distinct hosts, so the health evaluator reads a server independent of the keeper`,
    );
  }
  return servers;
};

type Draft<T> = { [K in keyof T]: T[K] | undefined };

const readCommon = (reader: Reader): Draft<CommonEnv> => ({
  network: reader.required('ATPRICE_NETWORK', parseNetwork, '"chipnet" or "mainnet"'),
  databaseUrl: reader.required('DATABASE_URL', parsePostgresUrl, 'a postgres:// URL'),
  electrumServers: reader.optional(
    'ELECTRUM_SERVERS',
    parseServers,
    'a comma-separated host:port list',
    null,
  ),
  sweepIntervalMs: reader.optional(
    'KEEPER_SWEEP_INTERVAL_MS',
    parseIntIn(5_000, 600_000),
    'milliseconds between 5000 and 600000',
    30_000,
  ),
  cohort: reader.optional(
    'ATPRICE_COHORT',
    parseCohort,
    'developer_test, pilot or production',
    'developer_test',
  ),
  logLevel: reader.optional('LOG_LEVEL', parseLogLevel, 'a pino level', 'info'),
});

const finish = <T>(reader: Reader, value: Draft<T>): T => {
  if (reader.issues.length > 0) throw new EnvValidationError(reader.issues);
  return value as T;
};

export const loadKeeperEnv = (source: Source = process.env): KeeperEnv => {
  const reader = new Reader(source);
  return finish<KeeperEnv>(reader, readCommon(reader));
};

export const loadApiEnv = (source: Source = process.env): ApiEnv => {
  const reader = new Reader(source);
  const common = readCommon(reader);
  return finish<ApiEnv>(reader, {
    ...common,
    apiPort: reader.required('API_PORT', parseIntIn(1, 65_535), 'a TCP port'),
    apiHost: reader.optional('API_HOST', (value) => value, 'a bind address', '0.0.0.0'),
    webOrigin: reader.required(
      'WEB_ORIGIN',
      parseOrigin,
      'an http(s) origin such as https://atprice.example',
    ),
    trustProxy: reader.required(
      'TRUST_PROXY',
      parseTrustProxy,
      '"none", a hop count 1-5, or proxy IPs/CIDRs',
    ),
    healthEvalIntervalMs: reader.optional(
      'HEALTH_EVAL_INTERVAL_MS',
      parseIntIn(5_000, 600_000),
      'milliseconds between 5000 and 600000',
      30_000,
    ),
  });
};

export const loadMigrateEnv = (source: Source = process.env): { databaseUrl: string } => {
  const reader = new Reader(source);
  const databaseUrl = reader.required('DATABASE_URL', parsePostgresUrl, 'a postgres:// URL');
  return finish(reader, { databaseUrl });
};

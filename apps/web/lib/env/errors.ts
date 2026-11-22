export type EnvErrorCode =
  | 'ENV_NETWORK_MISSING'
  | 'ENV_NETWORK_INVALID'
  | 'ENV_API_URL_MISSING'
  | 'ENV_API_URL_INVALID'
  | 'ENV_BUILD_SHA_MISSING'
  | 'BLAZE_DECK_URL_INVALID'
  | 'BLAZE_SOURCE_REPO_URL_INVALID'
  | 'BLAZE_EMBER_ADDRESS_INVALID';

/** A build-time configuration value is missing or malformed. `code` names the exact variable and fault. */
export class EnvError extends Error {
  readonly code: EnvErrorCode;
  readonly variable: string;

  constructor(code: EnvErrorCode, variable: string, detail: string) {
    super(`${code}: ${variable} ${detail}`);
    this.name = 'EnvError';
    this.code = code;
    this.variable = variable;
  }
}

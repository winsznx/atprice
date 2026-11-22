/**
 * Every API failure the browser can see, by name. Screens branch on `code`, print it in mono next to
 * the message (DD 7.13), and never on the message text.
 */
export type ApiErrorCode =
  /** The request never got an HTTP answer: DNS, TLS, CORS, offline, or the server is down. */
  | 'API_UNREACHABLE'
  /** No answer within the client timeout. */
  | 'API_TIMEOUT'
  /** The answer did not match the schema this build expects (a server/web version skew). */
  | 'API_RESPONSE_INVALID'
  /** The server answered with an error status; `serverCode` carries its named reason. */
  | 'API_ERROR';

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number | null;
  /** The server's own named reason (`intent_capacity`, `amount_below_minimum`, ...), when it sent one. */
  readonly serverCode: string | null;
  readonly endpoint: string;

  constructor(options: {
    code: ApiErrorCode;
    endpoint: string;
    message: string;
    status?: number | null;
    serverCode?: string | null;
    cause?: unknown;
  }) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApiError';
    this.code = options.code;
    this.endpoint = options.endpoint;
    this.status = options.status ?? null;
    this.serverCode = options.serverCode ?? null;
  }

  /** The code a screen prints: the server's reason when present, otherwise the client code. */
  get displayCode(): string {
    return this.serverCode ?? this.code;
  }
}

export const isApiError = (error: unknown): error is ApiError => error instanceof ApiError;

/** True when the error means "AtPrice's server is not responding" (DD 7.2 disabled reason). */
export const isUnreachable = (error: unknown): boolean =>
  isApiError(error) && (error.code === 'API_UNREACHABLE' || error.code === 'API_TIMEOUT');

/**
 * DD 7.13 error copy for a failed API read: what failed in the client's own words (`AtPrice's server is
 * not responding.`, a schema mismatch, a named server reason), what that blocks, and the code in mono.
 */
export const apiFailure = (error: unknown, consequence: string): { what: string; code: string } => {
  const consequenceText = consequence === '' ? '' : ` ${consequence}`;
  if (isApiError(error)) return { what: `${error.message}${consequenceText}`, code: error.displayCode };
  return {
    what: `${error instanceof Error ? error.message : 'The request failed.'}${consequenceText}`,
    code: 'API_ERROR',
  };
};

import type { ElectrumEndpoint } from '@atprice/chain';

/** A CLI failure with its message for stderr and the process exit code (2 for usage errors). */
export class CliExit extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = 'CliExit';
  }
}

/** `host:port` is a TLS socket, `wss://host[:port]` a secure WebSocket; both are verified by Node. */
export const parseCliServer = (value: string): ElectrumEndpoint => {
  const trimmed = value.trim();
  if (trimmed.startsWith('wss://')) {
    const url = new URL(trimmed);
    return { host: url.hostname, port: url.port === '' ? 443 : Number(url.port), transport: 'wss' };
  }
  const separator = trimmed.lastIndexOf(':');
  const host = trimmed.slice(0, separator);
  const port = Number(trimmed.slice(separator + 1));
  if (
    separator <= 0 ||
    !/^[a-z0-9.-]+$/i.test(host) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new CliExit(`--server must be host:port (TLS) or wss://host:port, got ${value}`, 2);
  }
  return { host, port, transport: 'tls' };
};

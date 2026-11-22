import { EventEmitter } from 'eventemitter3';
import type { ElectrumSocket, ElectrumSocketEvents, ElectrumSocketOptions } from '@electrum-cash/socket';
import type { ElectrumEndpoint } from '../../src/index.js';

type Handler = (params: unknown[]) => unknown;

/** An in-process Electrum server speaking newline-delimited JSON-RPC to `FakeSocket`s. */
export class FakeElectrumServer {
  down = false;
  genesis: string;
  readonly handlers = new Map<string, Handler>();
  readonly sockets = new Set<FakeSocket>();
  readonly calls: { method: string; params: unknown[] }[] = [];

  constructor(
    readonly host: string,
    genesis: string,
    readonly protocol = '1.5',
  ) {
    this.genesis = genesis;
    this.on('server.features', () => ({ genesis_hash: this.genesis }));
    this.on('server.ping', () => null);
  }

  on(method: string, handler: Handler): this {
    this.handlers.set(method, handler);
    return this;
  }

  handle(
    method: string,
    params: unknown[],
  ): { result: unknown } | { error: { code: number; message: string } } {
    this.calls.push({ method, params });
    if (method === 'server.version') return { result: [`Fake ${this.host}`, this.protocol] };
    const handler = this.handlers.get(method);
    if (handler === undefined) return { error: { code: -32601, message: `unknown method ${method}` } };
    try {
      return { result: handler(params) };
    } catch (error) {
      return { error: { code: 1, message: error instanceof Error ? error.message : String(error) } };
    }
  }

  notify(method: string, params: unknown): void {
    for (const socket of this.sockets) socket.push({ jsonrpc: '2.0', method, params });
  }

  /** Drops every open connection and refuses new ones until `revive()`. */
  async kill(): Promise<void> {
    this.down = true;
    for (const socket of [...this.sockets]) await socket.serverClose();
  }

  revive(): void {
    this.down = false;
  }

  /** Drops connections but keeps accepting new ones (a transient network blip). */
  async blip(): Promise<void> {
    for (const socket of [...this.sockets]) await socket.serverClose();
  }

  count(method: string): number {
    return this.calls.filter((call) => call.method === method).length;
  }
}

export class FakeSocket extends EventEmitter<ElectrumSocketEvents> implements ElectrumSocket {
  options: ElectrumSocketOptions;
  private state: 'connected' | 'disconnected' = 'disconnected';
  declare readonly data: [string];
  declare readonly connected: [];
  declare readonly disconnected: [];

  constructor(
    readonly server: FakeElectrumServer,
    readonly host: string,
    port: number,
  ) {
    super();
    this.options = { port, encrypted: true, timeoutInMilliSeconds: 5_000 };
  }

  get isConnecting(): boolean {
    return false;
  }
  get isConnected(): boolean {
    return this.state === 'connected';
  }
  get isDisconnecting(): boolean {
    return false;
  }
  get isDisconnected(): boolean {
    return this.state === 'disconnected';
  }

  async connect(): Promise<void> {
    if (this.server.down) {
      this.emit('disconnected');
      throw new Error(`connection to ${this.host} refused`);
    }
    this.state = 'connected';
    this.server.sockets.add(this);
    this.emit('connected');
  }

  async disconnect(): Promise<void> {
    if (this.state === 'disconnected') return;
    this.state = 'disconnected';
    this.server.sockets.delete(this);
    this.emit('disconnected');
  }

  async serverClose(): Promise<void> {
    await this.disconnect();
  }

  async write(data: string): Promise<boolean> {
    if (this.state !== 'connected') return false;
    for (const line of data.split('\n').filter((part) => part.length > 0)) {
      const request = JSON.parse(line) as { id: string | number; method: string; params?: unknown[] };
      const outcome = this.server.handle(request.method, request.params ?? []);
      setImmediate(() => this.push({ jsonrpc: '2.0', id: request.id, ...outcome }));
    }
    return true;
  }

  push(message: unknown): void {
    if (this.state === 'connected') this.emit('data', `${JSON.stringify(message)}\n`);
  }
}

export const fakeNetwork = (
  servers: readonly FakeElectrumServer[],
): { endpoints: ElectrumEndpoint[]; socketFactory: (endpoint: ElectrumEndpoint) => ElectrumSocket } => ({
  endpoints: servers.map((server) => ({ host: server.host, port: 50002, transport: 'tls' as const })),
  socketFactory: (endpoint) => {
    const server = servers.find((candidate) => candidate.host === endpoint.host);
    if (server === undefined) throw new Error(`no fake server ${endpoint.host}`);
    return new FakeSocket(server, endpoint.host, endpoint.port);
  },
});

export const waitFor = async (condition: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

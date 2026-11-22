import pg from 'pg';
import type { Logger } from 'pino';

export interface Listener {
  close(): Promise<void>;
}

/**
 * A dedicated connection that LISTENs on `channels` and reconnects after any error. A NOTIFY sent while
 * it is down is lost by design: the keeper's sweep reloads whatever it missed.
 */
export const listen = (
  databaseUrl: string,
  channels: readonly string[],
  onNotification: (channel: string, payload: string) => void,
  logger: Logger,
  onConnected: () => void = () => undefined,
): Listener => {
  let client: pg.Client | undefined;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const connect = async (): Promise<void> => {
    if (closed) return;
    const next = new pg.Client({ connectionString: databaseUrl, application_name: 'atprice-keeper-listen' });
    next.on('notification', (message) => onNotification(message.channel, message.payload ?? ''));
    next.on('error', (error) => {
      logger.warn({ err: error }, 'postgres listener error');
      scheduleReconnect(next);
    });
    next.on('end', () => scheduleReconnect(next));
    try {
      await next.connect();
      for (const channel of channels) await next.query(`LISTEN ${pg.escapeIdentifier(channel)}`);
      client = next;
      onConnected();
    } catch (error) {
      logger.warn({ err: error }, 'postgres listener could not connect');
      scheduleReconnect(next);
    }
  };

  const scheduleReconnect = (failed: pg.Client): void => {
    if (closed || retry !== undefined || (client !== undefined && client !== failed)) return;
    client = undefined;
    failed.end().catch(() => undefined);
    retry = setTimeout(() => {
      retry = undefined;
      void connect();
    }, 5_000);
  };

  void connect();
  return {
    close: async () => {
      closed = true;
      if (retry !== undefined) clearTimeout(retry);
      await client?.end().catch(() => undefined);
    },
  };
};

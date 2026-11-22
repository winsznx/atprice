import type { ElectrumEndpoint } from '@atprice/chain';
import { useId, useState, type ChangeEvent, type FormEvent, type RefObject } from 'react';
import { formatBlockHeight } from '../../../web/lib/format';
import { bundledServers, endpointHost, type RecoverConfig } from '../config';
import { parseServerUrl, SERVER_REASON } from '../core/inputs';
import type { ServerState } from '../core/server-session';
import { Badge, Button, cx, DisabledReason, ErrorBlock } from './primitives';
import { SectionHeading } from './section';

const CUSTOM = 'custom';

const sameEndpoint = (a: ElectrumEndpoint, b: ElectrumEndpoint): boolean =>
  a.host === b.host && a.port === b.port;

/** Step 1 of 4: the server the page talks to, which the user can see and change (recover.md hard rule 2). */
export function ServerSection({
  config,
  state,
  onConnect,
  headingRef,
}: {
  config: RecoverConfig;
  state: ServerState;
  onConnect: (endpoint: ElectrumEndpoint) => void;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const servers = bundledServers(config.network);
  const selectId = 'server-select';
  const customId = useId();
  const reasonId = useId();
  const [custom, setCustom] = useState('');
  const parsed = parseServerUrl(custom);
  const current = state.kind === 'idle' ? null : state.endpoint;
  const selectedValue =
    current === null
      ? ''
      : (() => {
          const index = servers.findIndex((server) => sameEndpoint(server, current));
          return index < 0 ? CUSTOM : String(index);
        })();

  const onSelect = (event: ChangeEvent<HTMLSelectElement>) => {
    const server = servers[Number(event.target.value)];
    if (server !== undefined) onConnect(server);
  };

  const onUseCustom = (event: FormEvent) => {
    event.preventDefault();
    if (parsed.ok) onConnect(parsed.value);
  };

  return (
    <section aria-labelledby="step-server" className="flex flex-col gap-4">
      <SectionHeading id="step-server" step={1} title="Server" headingRef={headingRef} />
      <div className="flex flex-col gap-2">
        <label htmlFor={selectId} className="text-label text-fg">
          Bitcoin Cash server
        </label>
        <select
          id={selectId}
          value={selectedValue}
          onChange={onSelect}
          className="min-h-(--size-control) w-full rounded-md border border-border-input bg-surface px-3 text-body text-fg"
        >
          {selectedValue === '' ? (
            <option value="" disabled>
              Choose a server
            </option>
          ) : null}
          {servers.map((server, index) => (
            <option key={`${server.host}:${server.port}`} value={String(index)}>
              {endpointHost(server)}
            </option>
          ))}
          {selectedValue === CUSTOM && current !== null ? (
            <option value={CUSTOM} disabled>
              {endpointHost(current)} (your server)
            </option>
          ) : null}
        </select>
      </div>
      <ServerStatus state={state} network={config.network} />
      <form onSubmit={onUseCustom} className="flex flex-col gap-2">
        <label htmlFor={customId} className="text-label text-fg">
          Use a different server
        </label>
        <div className="flex flex-col gap-2 xs:flex-row">
          <input
            id={customId}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="wss://"
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
            aria-describedby={parsed.ok ? undefined : reasonId}
            className="hash min-h-(--size-control) w-full min-w-0 rounded-md border border-border-input bg-surface px-3 text-body text-fg"
          />
          <Button
            type="submit"
            variant="outline"
            aria-disabled={!parsed.ok || undefined}
            aria-describedby={parsed.ok ? undefined : reasonId}
          >
            Use server
          </Button>
        </div>
        {parsed.ok ? null : <DisabledReason id={reasonId}>{SERVER_REASON}</DisabledReason>}
      </form>
    </section>
  );
}

function ServerStatus({ state, network }: { state: ServerState; network: RecoverConfig['network'] }) {
  switch (state.kind) {
    case 'idle':
      return (
        <p role="status" className="text-body-sm text-fg-muted">
          Not connected. Choose a server to start.
        </p>
      );
    case 'connecting':
      return (
        <p role="status" aria-busy="true" className="text-body-sm text-fg-secondary">
          Connecting to {state.host}
        </p>
      );
    case 'connected':
      return (
        <div className="flex flex-col gap-1">
          <p role="status" className="sr-only">
            {state.lost
              ? `Connection to ${state.host} lost. Reconnecting.`
              : `Connected to ${state.host}, ${network}, block ${formatBlockHeight(state.tip)}`}
          </p>
          <p aria-hidden="true" className="flex flex-wrap items-center gap-2 text-body-sm text-fg-secondary">
            <Badge tone={state.lost ? 'pending' : 'open'}>{state.lost ? 'Reconnecting' : 'Connected'}</Badge>
            <span>
              {network} · block <span className="num">{formatBlockHeight(state.tip)}</span>
            </span>
          </p>
          {state.lost ? (
            <p className={cx('text-body-sm text-fg-secondary')}>
              The connection to {state.host} dropped. This page reconnects to the same server; pick another
              one if it stays down.
            </p>
          ) : null}
        </div>
      );
    case 'error':
      return (
        <ErrorBlock
          message={state.error.message}
          code={state.error.code}
          detail={state.error.cause instanceof Error ? state.error.cause.message : undefined}
        />
      );
  }
}

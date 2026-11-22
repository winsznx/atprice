import type { ElectrumEndpoint } from '@atprice/chain';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { bundledServers, type RecoverConfig } from '../config';
import { describeError, errorCode } from '../core/errors';
import { parseOwnerAddress, parseTxid } from '../core/inputs';
import { findOrderByTxid, findOrdersByAddress, readOrderStatus, type LoadedOrder } from '../core/lookup';
import type { ServerSession } from '../core/server-session';
import type { RecoverWallet } from '../wallet/session';
import { CancelSection, useCancelPlan, type SentState } from './cancel-section';
import { FindSection, type LookupMode, type SearchActivity } from './find-section';
import { useLatest } from './hooks';
import { OrderSection, type OrderResults } from './order-section';
import { ErrorBlock } from './primitives';
import { CollapsedSection } from './section';
import { ServerSection } from './server-section';
import { Footer, Header, OtherWays } from './shell';

export interface Prefill {
  readonly mode: LookupMode;
  readonly value: string;
}

/** `?txid=` or `?address=` from order detail, cancel confirmation or the funding flow (recover.md "Route"). */
export const readPrefill = (search: string): Prefill | null => {
  const params = new URLSearchParams(search);
  const txid = params.get('txid');
  if (txid !== null && txid.trim() !== '') return { mode: 'txid', value: txid.trim() };
  const address = params.get('address');
  if (address !== null && address.trim() !== '') return { mode: 'address', value: address.trim() };
  return null;
};

type FocusTarget = 'find' | 'order';

const outpointKey = (order: LoadedOrder): string => `${order.funding.txid}:${order.funding.vout}`;

const sameOrder = (a: LoadedOrder, b: LoadedOrder): boolean => outpointKey(a) === outpointKey(b);

/** Scroll and focus are instant (recover.md "Layout": no smooth scrolling, no M-07). */
const reveal = (element: HTMLElement | null): void => {
  if (element === null) return;
  element.scrollIntoView({ behavior: 'auto', block: 'start' });
  element.focus({ preventScroll: true });
};

/** Step 3 and 4 and `Other ways` for one loaded order; keyed by the order so its cancel state resets. */
function OrderActions(props: {
  config: RecoverConfig;
  order: LoadedOrder;
  session: ServerSession;
  wallet: RecoverWallet;
  sent: SentState | null;
  onOrderChanged: (order: LoadedOrder) => void;
  onCancelSent: (order: LoadedOrder, txid: string) => void;
  onPickServer: () => void;
  cancelRef: RefObject<HTMLHeadingElement | null>;
}) {
  const server = useSyncExternalStore(props.session.subscribe, props.session.getState);
  const walletState = useSyncExternalStore(props.wallet.subscribe, props.wallet.getState);
  const { coins, checkAgain, plan, path, setPath } = useCancelPlan(server, props.order);
  const { order } = props;
  const showCancel = order.status.kind === 'unspent' || props.sent !== null;
  return (
    <>
      {showCancel ? (
        <CancelSection
          config={props.config}
          order={order}
          server={server}
          wallet={props.wallet}
          walletState={walletState}
          coins={coins}
          checkAgain={checkAgain}
          plan={plan}
          path={path}
          onPathChange={setPath}
          sent={props.sent}
          onOrderChanged={props.onOrderChanged}
          onCancelSent={(txid) => props.onCancelSent(order, txid)}
          onPickServer={props.onPickServer}
          headingRef={props.cancelRef}
        />
      ) : (
        <SpentSummary order={order} />
      )}
      <OtherWays order={order} plan={plan} />
    </>
  );
}

function SpentSummary({ order }: { order: LoadedOrder }) {
  const status = order.status;
  const summary =
    status.kind === 'filled' ? (
      <>
        Nothing to cancel. This order was filled in <span className="hash">{status.txid}</span>.
      </>
    ) : status.kind === 'cancelled' ? (
      <>
        Nothing to cancel. This order was cancelled in <span className="hash">{status.txid}</span>.
      </>
    ) : status.kind === 'needs_review' ? (
      <>
        Nothing to cancel here. The order output was already spent in{' '}
        <span className="hash">{status.txid}</span>.
      </>
    ) : null;
  return <CollapsedSection id="step-cancel" step={4} title="Cancel" summary={summary} />;
}

export function App({
  config,
  session,
  wallet,
  fileHash,
  prefill,
}: {
  config: RecoverConfig;
  session: ServerSession;
  wallet: RecoverWallet;
  fileHash: string | null;
  prefill: Prefill | null;
}) {
  const server = useSyncExternalStore(session.subscribe, session.getState);
  const walletState = useSyncExternalStore(wallet.subscribe, wallet.getState);
  const [mode, setMode] = useState<LookupMode>(prefill?.mode ?? 'txid');
  const [value, setValue] = useState(prefill?.value ?? '');
  const [activity, setActivity] = useState<SearchActivity>({ kind: 'idle' });
  const [searchError, setSearchError] = useState<unknown>(null);
  const [results, setResults] = useState<OrderResults | null>(null);
  const [selected, setSelected] = useState<LoadedOrder | null>(null);
  const [sent, setSent] = useState<ReadonlyMap<string, SentState>>(new Map());
  const [focus, setFocus] = useState<{ target: FocusTarget; request: number } | null>(null);
  const serverRef = useRef<HTMLHeadingElement>(null);
  const findRef = useRef<HTMLHeadingElement>(null);
  const orderRef = useRef<HTMLHeadingElement>(null);
  const cancelRef = useRef<HTMLHeadingElement>(null);
  const searchGeneration = useRef(0);
  const prefillStarted = useRef(false);

  useLayoutEffect(() => {
    if (focus === null) return;
    reveal(focus.target === 'find' ? findRef.current : orderRef.current);
  }, [focus]);

  const requestFocus = (target: FocusTarget) =>
    setFocus((previous) => ({ target, request: (previous?.request ?? 0) + 1 }));

  const replaceOrder = (order: LoadedOrder) => {
    setSelected((current) => (current !== null && sameOrder(current, order) ? order : current));
    setResults((current) =>
      current?.kind === 'orders'
        ? { ...current, orders: current.orders.map((entry) => (sameOrder(entry, order) ? order : entry)) }
        : current,
    );
  };

  const runFind = async (lookupMode: LookupMode, input: string) => {
    const state = session.getState();
    if (state.kind !== 'connected') return;
    const generation = ++searchGeneration.current;
    const isCurrent = () => generation === searchGeneration.current;
    setActivity({ kind: 'searching', checked: 0, total: null });
    setSearchError(null);
    setResults(null);
    setSelected(null);
    try {
      if (lookupMode === 'txid') {
        const txid = parseTxid(input);
        if (!txid.ok) return;
        const found = await findOrderByTxid(state.chain, config.network, txid.value);
        if (!isCurrent()) return;
        if (found.kind === 'order') {
          setResults({ kind: 'orders', orders: [found.order], unknownVersions: [] });
          setSelected(found.order);
        } else {
          setResults(found.kind === 'no_record' ? { kind: 'no_record' } : found);
        }
      } else {
        const owner = parseOwnerAddress(input, config.network);
        if (!owner.ok) return;
        const found = await findOrdersByAddress(
          state.chain,
          config.network,
          owner.value.ownerPkh,
          (checked, total) => {
            if (isCurrent()) setActivity({ kind: 'searching', checked, total });
          },
        );
        if (!isCurrent()) return;
        if (found.orders.length === 0 && found.unknownVersions.length === 0) {
          setResults({ kind: 'no_orders' });
        } else {
          setResults({ kind: 'orders', orders: found.orders, unknownVersions: found.unknownVersions });
          setSelected(found.orders.length === 1 ? (found.orders[0] ?? null) : null);
        }
      }
      requestFocus('order');
    } catch (error) {
      if (isCurrent()) setSearchError(error);
    } finally {
      if (isCurrent()) setActivity({ kind: 'idle' });
    }
  };

  const connect = async (endpoint: ElectrumEndpoint): Promise<boolean> => {
    const connected = await session.connect(endpoint);
    if (connected) requestFocus('find');
    return connected;
  };

  // A prefilled link connects to the first bundled server and searches once, on first display.
  const runPrefill = useLatest(async () => {
    const first = bundledServers(config.network)[0];
    if (prefill === null || first === undefined) return;
    if (await session.connect(first)) await runFind(prefill.mode, prefill.value);
  });
  useEffect(() => {
    if (prefillStarted.current) return;
    prefillStarted.current = true;
    void runPrefill.current();
  }, [runPrefill]);

  const onCancelSent = (order: LoadedOrder, txid: string) => {
    setSent((current) => new Map(current).set(outpointKey(order), { txid, height: 0 }));
    const state = session.getState();
    if (state.kind !== 'connected') return;
    readOrderStatus(
      state.chain,
      order.record,
      order.lockingBytecode,
      order.funding,
      order.fundingOutput,
    ).then(
      ({ status, fundingHeight }) => replaceOrder({ ...order, status, fundingHeight }),
      (error: unknown) => console.error('Re-reading the order after the cancel failed:', error),
    );
  };

  // Each new block re-reads a cancel this page sent until it confirms (the server is the external system).
  const tip = server.kind === 'connected' ? server.tip : 0;
  const chain = server.kind === 'connected' ? server.chain : null;
  const selectedKey = selected === null ? null : outpointKey(selected);
  const pendingSent = selectedKey === null ? undefined : sent.get(selectedKey);
  const selectedLatest = useLatest(selected);
  const pendingTxid = pendingSent !== undefined && pendingSent.height <= 0 ? pendingSent.txid : null;
  useEffect(() => {
    const order = selectedLatest.current;
    if (chain === null || order === null || pendingTxid === null) return;
    let current = true;
    readOrderStatus(chain, order.record, order.lockingBytecode, order.funding, order.fundingOutput).then(
      ({ status, fundingHeight }) => {
        if (!current) return;
        setSelected((existing) =>
          existing !== null && sameOrder(existing, order) ? { ...existing, status, fundingHeight } : existing,
        );
        if (status.kind === 'cancelled' && status.txid === pendingTxid && status.height > 0) {
          setSent((map) =>
            new Map(map).set(outpointKey(order), { txid: pendingTxid, height: status.height }),
          );
        }
      },
      (error: unknown) =>
        console.error('Checking the cancel confirmation failed; retrying at the next block:', error),
    );
    return () => {
      current = false;
    };
  }, [chain, tip, pendingTxid, selectedLatest]);

  const pickServer = () => {
    const select = document.getElementById('server-select');
    if (select !== null) reveal(select);
  };

  const walletAddress = walletState.kind === 'connected' ? walletState.owner.address : null;

  return (
    <div className="flex min-h-dvh flex-col bg-surface">
      <Header config={config} />
      <main className="mx-auto flex w-full max-w-(--container-content) flex-1 flex-col gap-8 px-4 py-8 md:px-6 lg:py-12">
        <div className="flex max-w-(--container-prose) flex-col gap-3">
          <h1 className="text-heading-2 text-fg md:text-heading-1">Recover an order</h1>
          <p className="text-body text-fg-secondary">
            Find an AtPrice order on chain and cancel it with your wallet. This page talks only to a Bitcoin
            Cash server you choose and to your wallet, never to AtPrice's servers.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-12">
          <div className="flex min-w-0 flex-col gap-10">
            <ServerSection
              config={config}
              state={server}
              onConnect={(endpoint) => void connect(endpoint)}
              headingRef={serverRef}
            />
            <div className="flex flex-col gap-4">
              <FindSection
                network={config.network}
                connected={server.kind === 'connected'}
                mode={mode}
                value={value}
                activity={activity}
                walletAddress={walletAddress}
                onModeChange={setMode}
                onValueChange={setValue}
                onFind={() => void runFind(mode, value)}
                headingRef={findRef}
              />
              {searchError === null ? null : (
                <ErrorBlock
                  message={`The search on ${server.kind === 'idle' ? 'the server' : server.host} failed: ${describeError(searchError)}`}
                  code={errorCode(searchError)}
                />
              )}
            </div>
          </div>
          <div className="flex min-w-0 flex-col gap-10">
            {results === null ? (
              activity.kind === 'searching' ? (
                <section aria-labelledby="step-order" aria-busy="true" className="flex flex-col gap-4">
                  <CollapsedSection id="step-order" step={3} title="Order" summary="Searching." />
                  <div aria-hidden="true" className="h-64 rounded-md bg-surface-muted" />
                </section>
              ) : (
                <CollapsedSection
                  id="step-order"
                  step={3}
                  title="Order"
                  summary="Find an order in step 2 first."
                />
              )
            ) : (
              <OrderSection
                network={config.network}
                results={results}
                selected={selected}
                onSelect={setSelected}
                tip={tip}
                headingRef={orderRef}
              />
            )}
            {selected === null ? (
              <>
                <CollapsedSection
                  id="step-cancel"
                  step={4}
                  title="Cancel"
                  summary={
                    results?.kind === 'unknown_version'
                      ? "Cancel isn't possible for this contract version here."
                      : 'Opens when an order is loaded.'
                  }
                />
                <OtherWays order={null} plan={null} />
              </>
            ) : (
              <OrderActions
                key={outpointKey(selected)}
                config={config}
                order={selected}
                session={session}
                wallet={wallet}
                sent={sent.get(outpointKey(selected)) ?? null}
                onOrderChanged={replaceOrder}
                onCancelSent={onCancelSent}
                onPickServer={pickServer}
                cancelRef={cancelRef}
              />
            )}
          </div>
        </div>
      </main>
      <Footer config={config} fileHash={fileHash} />
    </div>
  );
}

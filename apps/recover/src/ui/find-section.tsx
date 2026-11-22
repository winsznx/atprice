import type { Network } from '@atprice/core';
import { useId, type FormEvent, type RefObject } from 'react';
import { parseOwnerAddress, parseTxid } from '../core/inputs';
import { Button, cx, DisabledReason } from './primitives';
import { SectionHeading } from './section';

export type LookupMode = 'txid' | 'address';

export type SearchActivity =
  | { readonly kind: 'idle' }
  | { readonly kind: 'searching'; readonly checked: number; readonly total: number | null };

export const SERVER_FIRST = 'Connect to a server first.';

export const USE_WALLET_REASON =
  "Connect a wallet in step 4 to use its address. Step 4 opens once an order is found, so search by transaction id or type the address for now.";

/** The first failing reason for `Find order`, or null when it can run (recover.md "Controls"). */
export const findBlocker = (
  connected: boolean,
  mode: LookupMode,
  value: string,
  network: Network,
): string | null => {
  if (!connected) return SERVER_FIRST;
  const parsed = mode === 'txid' ? parseTxid(value) : parseOwnerAddress(value, network);
  return parsed.ok ? null : parsed.reason;
};

/** Step 2 of 4: a funding transaction id or an owner address. */
export function FindSection({
  network,
  connected,
  mode,
  value,
  activity,
  walletAddress,
  onModeChange,
  onValueChange,
  onFind,
  headingRef,
}: {
  network: Network;
  connected: boolean;
  mode: LookupMode;
  value: string;
  activity: SearchActivity;
  walletAddress: string | null;
  onModeChange: (mode: LookupMode) => void;
  onValueChange: (value: string) => void;
  onFind: () => void;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const inputId = useId();
  const modeReasonId = useId();
  const findReasonId = useId();
  const walletReasonId = useId();
  const blocker = findBlocker(connected, mode, value, network);
  const searching = activity.kind === 'searching';
  const findDisabled = blocker !== null || searching;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!findDisabled) onFind();
  };

  const modeOption = (option: LookupMode, label: string) => (
    <label
      className={cx(
        'flex min-h-(--size-control) flex-1 cursor-pointer items-center justify-center gap-2 rounded-sm px-3 text-label text-fg-secondary has-checked:bg-surface has-checked:text-fg has-checked:shadow-inset',
        !connected && 'cursor-not-allowed text-fg-disabled',
      )}
    >
      <input
        type="radio"
        name="lookup-mode"
        value={option}
        checked={mode === option}
        aria-disabled={!connected || undefined}
        aria-describedby={connected ? undefined : modeReasonId}
        onChange={() => {
          if (connected) onModeChange(option);
        }}
        className="size-4 accent-brand"
      />
      {label}
    </label>
  );

  return (
    <section aria-labelledby="step-find" className="flex flex-col gap-4">
      <SectionHeading id="step-find" step={2} title="Find the order" headingRef={headingRef} />
      <form onSubmit={submit} className="flex flex-col gap-4" aria-busy={searching || undefined}>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-label text-fg">Search by</legend>
          <div className="flex flex-col gap-1 rounded-md bg-surface-sunken p-1 xs:flex-row">
            {modeOption('txid', 'Funding transaction id')}
            {modeOption('address', 'Owner address')}
          </div>
          {connected ? null : <DisabledReason id={modeReasonId}>{SERVER_FIRST}</DisabledReason>}
        </fieldset>
        <div className="flex flex-col gap-2">
          <label htmlFor={inputId} className="text-label text-fg">
            {mode === 'txid' ? 'Funding transaction id' : 'Owner address'}
          </label>
          <input
            id={inputId}
            type="text"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={value}
            readOnly={!connected}
            aria-disabled={!connected || undefined}
            aria-describedby={blocker === null ? undefined : findReasonId}
            onChange={(event) => onValueChange(event.target.value)}
            placeholder={mode === 'txid' ? '64 characters, 0-9 and a-f' : `${network === 'mainnet' ? 'bitcoincash' : 'bchtest'}:q…`}
            className="hash min-h-(--size-control) w-full min-w-0 rounded-md border border-border-input bg-surface px-3 text-body text-fg aria-disabled:bg-surface-muted"
          />
        </div>
        {mode === 'address' ? (
          <div className="flex flex-col gap-1">
            <Button
              variant="outline"
              className="self-start"
              aria-disabled={walletAddress === null || undefined}
              aria-describedby={walletAddress === null ? walletReasonId : undefined}
              onClick={() => {
                if (walletAddress !== null) onValueChange(walletAddress);
              }}
            >
              Use my wallet's address
            </Button>
            {walletAddress === null ? <DisabledReason id={walletReasonId}>{USE_WALLET_REASON}</DisabledReason> : null}
          </div>
        ) : null}
        <div className="flex flex-col gap-1">
          <Button
            type="submit"
            className="self-stretch xs:self-start"
            aria-disabled={findDisabled || undefined}
            aria-describedby={blocker === null ? undefined : findReasonId}
          >
            {searching ? 'Searching' : 'Find order'}
          </Button>
          {blocker === null ? null : <DisabledReason id={findReasonId}>{blocker}</DisabledReason>}
          {activity.kind === 'searching' && activity.total !== null && mode === 'address' ? (
            <p role="status" aria-live="polite" className="text-body-sm text-fg-secondary">
              Checked <span className="num">{activity.checked}</span> of <span className="num">{activity.total}</span>{' '}
              transactions
            </p>
          ) : null}
        </div>
      </form>
    </section>
  );
}

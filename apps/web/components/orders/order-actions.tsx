'use client';

import { CheckIcon, CopyIcon, ShareNetworkIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useId, useState, type RefObject } from 'react';
import { useCopy } from '@/components/hash-chip';
import { DisabledReason } from '@/components/states';
import { Button, buttonVariants } from '@/components/ui/button';
import { ConnectWalletButton } from '@/components/wallet/wallet-button';
import { formatElapsed } from '@/lib/format';
import { useElapsed } from '@/lib/hooks/use-now';
import { RECONNECTING_REASON, type CancelAvailability, type Ownership } from './order-detail';

/** `Share order`: the Web Share API where it exists (mobile), else the URL is copied. Only the URL. */
export function ShareButton({ url }: { url: string }) {
  const { state, copy } = useCopy(url);
  const [shareError, setShareError] = useState<string | null>(null);
  const onShare = async () => {
    setShareError(null);
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ url });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        console.warn('Web Share failed, copying the link instead:', error);
      }
    }
    if (!(await copy())) setShareError(`Copy failed. The link is ${url}`);
  };
  return (
    <span className="inline-flex flex-col gap-1">
      <Button variant="outline" size="compact" onClick={() => void onShare()}>
        <ShareNetworkIcon aria-hidden="true" />
        Share order
      </Button>
      <span
        role="status"
        aria-live="polite"
        className={state === 'copied' ? 'text-caption text-fg-muted' : 'sr-only'}
      >
        {state === 'copied' ? 'Link copied' : ''}
      </span>
      {shareError === null ? null : <span className="text-body-sm text-status-failed">{shareError}</span>}
    </span>
  );
}

export function CopyOrderIdButton({ txid }: { txid: string }) {
  const { state, copy } = useCopy(txid);
  return (
    <span className="inline-flex flex-col gap-1">
      <Button variant="outline" size="compact" onClick={() => void copy()}>
        {state === 'copied' ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
        Copy order id
      </Button>
      <span
        role="status"
        aria-live="polite"
        className={state === 'failed' ? 'text-body-sm text-status-failed' : 'sr-only'}
      >
        {state === 'copied'
          ? 'Order id copied'
          : state === 'failed'
            ? 'Copy failed. Select the order id instead.'
            : ''}
      </span>
    </span>
  );
}

function ReconnectingReason({ id, since }: { id: string; since: number | null }) {
  const elapsed = useElapsed(since);
  return <DisabledReason id={id}>{RECONNECTING_REASON(formatElapsed(elapsed ?? 0))}</DisabledReason>;
}

/**
 * The action row's owner part (order-detail.md "States"): `Cancel order` for the owner, or the line
 * that explains why there is none. Connecting replaces the line, so focus goes to `Cancel order` or
 * to the new line (`<p tabindex="-1">`).
 */
export function CancelAction({
  ownership,
  availability,
  recoverHref,
  networkMismatch,
  cancelRef,
  messageRef,
  onCancel,
}: {
  ownership: Ownership;
  availability: CancelAvailability;
  recoverHref: string;
  networkMismatch: boolean;
  cancelRef: RefObject<HTMLButtonElement | null>;
  messageRef: RefObject<HTMLParagraphElement | null>;
  onCancel: () => void;
}) {
  const reasonId = useId();
  const recover = (
    <Link href={recoverHref} className={buttonVariants({ variant: 'outline', size: 'compact' })}>
      Open in Recover
    </Link>
  );
  const message = (text: string) => (
    <p ref={messageRef} tabIndex={-1} className="max-w-[64ch] text-body-sm text-fg-secondary">
      {text}
    </p>
  );

  switch (ownership.kind) {
    case 'unknown':
      return null;
    case 'disconnected':
      return (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-body-sm text-fg-secondary">
            Connect the wallet that created this order to cancel it.
          </p>
          <ConnectWalletButton
            size="compact"
            variant="outline"
            fallback={() => cancelRef.current ?? messageRef.current}
          />
        </div>
      );
    case 'not_owner':
      return message(
        'This order belongs to a different wallet. Only the wallet that created it can cancel it.',
      );
    case 'missing_receive':
      return (
        <div className="flex flex-col items-start gap-2">
          {message(
            'Your wallet didn’t share the receive key path AtPrice uses to own orders, so it can’t cancel here. Recover can cancel with the wallet that created the order.',
          )}
          {recover}
        </div>
      );
    case 'wrong_network':
      return message(ownership.copy);
    case 'owner':
      break;
  }
  if (availability.kind === 'hidden') return null;
  const disabled = availability.kind === 'disabled';
  return (
    <div className="flex w-full flex-col gap-2 md:w-auto">
      <Button
        ref={cancelRef}
        variant="destructive"
        className="w-full md:w-auto"
        aria-disabled={disabled || undefined}
        aria-describedby={disabled ? reasonId : undefined}
        onClick={onCancel}
      >
        Cancel order
      </Button>
      {availability.kind !== 'disabled' ? null : availability.reconnecting ? (
        <ReconnectingReason id={reasonId} since={ownership.reconnectingSince} />
      ) : (
        <DisabledReason id={reasonId}>{availability.reason}</DisabledReason>
      )}
      {networkMismatch ? recover : null}
    </div>
  );
}

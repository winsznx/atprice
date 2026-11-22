'use client';

import { useRouter } from 'next/navigation';
import { useId, useState, type FormEvent } from 'react';
import { DisabledReason } from '@/components/states';
import { Button } from '@/components/ui/button';
import { normalizeTxid } from './order-lists';

/** `Have a funding transaction id? Look it up` (orders.md "Disconnected"): routes to the public page. */
export function TxidLookup() {
  const router = useRouter();
  const inputId = useId();
  const reasonId = useId();
  const [value, setValue] = useState('');
  const txid = normalizeTxid(value);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (txid !== null) router.push(`/orders/${txid}`);
  };

  return (
    <form onSubmit={onSubmit} className="flex w-full max-w-[40rem] flex-col gap-2">
      <label htmlFor={inputId} className="text-body-sm text-fg-secondary">
        Have a funding transaction id? Look it up
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id={inputId}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          aria-describedby={txid === null ? reasonId : undefined}
          className="hash min-h-(--size-control) w-full min-w-0 rounded-md border border-border-input bg-surface px-3 text-body text-fg placeholder:text-fg-muted"
        />
        <Button
          type="submit"
          variant="outline"
          aria-disabled={txid === null || undefined}
          aria-describedby={txid === null ? reasonId : undefined}
        >
          Look it up
        </Button>
      </div>
      {txid === null ? <DisabledReason id={reasonId}>Enter a 64-character transaction id.</DisabledReason> : null}
    </form>
  );
}

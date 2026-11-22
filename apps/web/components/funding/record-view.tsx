'use client';

import { binToHex } from '@bitauth/libauth';
import { decodeOrderRecord, RECORD_MAGIC, type OrderRecord } from '@atprice/core';
import { CaretDownIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { CONTROL_TRANSITION } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { formatSats } from '@/lib/format';
import { cn } from '@/lib/utils';

const decode = (record: Uint8Array): OrderRecord | { error: string } => {
  try {
    return decodeOrderRecord(record);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};

/**
 * The decoded `ATPR` record (funding-confirmation.md "Controls", M-07). The raw `minOut` appears only
 * here, labelled as the contract value (DD 4.1).
 */
export function RecordView({ record }: { record: Uint8Array }) {
  const [open, setOpen] = useState(false);
  const decoded = decode(record);
  const rows: [string, string][] =
    'error' in decoded
      ? [['Decode error', decoded.error]]
      : [
          ['Magic', new TextDecoder().decode(RECORD_MAGIC)],
          ['Version', decoded.version.toString()],
          ['Side', decoded.side],
          ['Owner key hash', binToHex(decoded.ownerPkh)],
          ['Token category', decoded.tokenCategory],
          [
            'minOut (contract value; for a sell this includes the 2,000 sat reserve)',
            formatSats(decoded.minOut),
          ],
          ['Fee cap', `${formatSats(decoded.maxNetworkFee)} sat`],
          ['Nonce', binToHex(decoded.nonce)],
          ['Recipient script', binToHex(decoded.recipientLockingBytecode)],
        ];
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className={cn(
          'flex min-h-(--size-control) w-full items-center justify-between gap-3 rounded-sm text-left text-label text-fg',
          CONTROL_TRANSITION,
        )}
      >
        On-chain order record (OP_RETURN)
        <span className="flex items-center gap-1 text-body-sm text-fg-secondary">
          {open ? 'Hide' : 'Show'}
          <CaretDownIcon aria-hidden="true" className={cn('size-4', open && 'rotate-180')} />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <dl className="flex flex-col gap-2 pt-2">
          {rows.map(([label, value]) => (
            <div key={label} className="flex flex-col gap-0.5">
              <dt className="text-caption text-fg-muted">{label}</dt>
              <dd className="hash text-mono-sm break-all text-fg">{value}</dd>
            </div>
          ))}
          <div className="flex flex-col gap-0.5">
            <dt className="text-caption text-fg-muted">Raw record</dt>
            <dd className="hash text-mono-sm break-all text-fg-secondary">{binToHex(record)}</dd>
          </div>
        </dl>
      </CollapsibleContent>
    </Collapsible>
  );
}

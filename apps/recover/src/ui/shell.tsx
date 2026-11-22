import { ArrowSquareOutIcon } from '@phosphor-icons/react/dist/ssr';
import { NETWORK_BADGE, type RecoverConfig } from '../config';
import { parametersJson } from '../core/describe';
import { unsignedCancelJson, type CancelPlan } from '../core/cancel';
import type { LoadedOrder } from '../core/lookup';
import { Badge, CopyTextButton, HashChip } from './primitives';
import { SectionHeading } from './section';

/** DD 2 mark, drawn with token fills so no colour value sits in component code. */
function Mark() {
  return (
    <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true" className="shrink-0">
      <rect width="32" height="32" rx="9" className="fill-brand" />
      <path d="M6 11H26" fill="none" strokeWidth="2" strokeLinecap="round" className="stroke-brand-fg" />
      <path
        d="M6 24L10 19.5L13 22L17 11"
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-brand-fg"
      />
      <circle cx="17" cy="11" r="3.25" strokeWidth="1.5" className="fill-brand-fg stroke-brand" />
    </svg>
  );
}

export function Header({ config }: { config: RecoverConfig }) {
  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto flex min-h-14 max-w-(--container-content) flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 md:px-6">
        <p className="flex items-center gap-2.5">
          <Mark />
          <span className="text-body font-semibold tracking-tight text-fg">
            <span className="font-normal">At</span>Price
          </span>
          <span className="text-body text-fg-secondary">Recover</span>
        </p>
        <Badge tone={config.network === 'mainnet' ? 'cancelled' : 'pending'}>
          {NETWORK_BADGE[config.network]}
        </Badge>
        {config.websiteUrl === null ? null : (
          <a
            href={config.websiteUrl}
            className="inline-flex min-h-11 items-center gap-1 text-body-sm text-link underline-offset-4 hover:underline md:ml-auto"
          >
            AtPrice website
            <ArrowSquareOutIcon aria-hidden="true" className="size-4" />
          </a>
        )}
      </div>
    </header>
  );
}

export function Footer({ config, fileHash }: { config: RecoverConfig; fileHash: string | null }) {
  return (
    <footer className="border-t border-border bg-surface-sunken">
      <div className="mx-auto flex max-w-(--container-content) flex-col gap-3 px-4 py-6 text-body-sm text-fg-secondary md:flex-row md:flex-wrap md:items-center md:gap-x-6 md:px-6">
        <span>
          AtPrice Recover <span className="num">{config.version}</span>
        </span>
        {fileHash === null ? (
          <span>File SHA-256: not computed in this view.</span>
        ) : (
          <span className="flex flex-wrap items-center gap-2">
            File SHA-256
            <HashChip
              value={fileHash}
              kind="hash"
              display={`${fileHash.slice(0, 8)}…${fileHash.slice(-8)}`}
              label={`File SHA-256 ${fileHash}`}
              copyLabel="Copy file SHA-256"
            />
          </span>
        )}
        {config.sourceUrl === null ? null : (
          <a
            href={config.sourceUrl}
            className="inline-flex min-h-11 items-center gap-1 text-link underline-offset-4 hover:underline"
          >
            Source code
            <ArrowSquareOutIcon aria-hidden="true" className="size-4" />
          </a>
        )}
      </div>
    </footer>
  );
}

/** `Other ways`: the same recovery without this page's wallet connection. */
export function OtherWays({ order, plan }: { order: LoadedOrder | null; plan: CancelPlan | null }) {
  const txid = order?.funding.txid ?? '<funding txid>';
  return (
    <section aria-labelledby="other-ways" className="flex flex-col gap-4">
      <SectionHeading id="other-ways" title="Other ways" />
      <div className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-start">
        <CopyTextButton
          value={order === null ? null : parametersJson(order)}
          reasonId="copy-parameters-reason"
          disabledReason="Find an order first."
        >
          Copy parameters (JSON)
        </CopyTextButton>
        <CopyTextButton
          value={plan?.kind === 'ready' ? unsignedCancelJson(plan.cancel) : null}
          reasonId="copy-unsigned-reason"
          disabledReason="Available once an unspent order is loaded and its cancel is built."
        >
          Copy unsigned tx
        </CopyTextButton>
      </div>
      <p className="text-body-sm text-fg-secondary">
        It needs the owner's signature (on the owner coin for cancel(), or inside the contract for
        cancelWithSig) before it can be broadcast.
      </p>
      <p className="max-w-prose text-body-sm text-fg-secondary">
        The same recovery runs from the source code:{' '}
        <code className="hash text-mono-sm text-fg">pnpm recover --txid {txid}</code>. It prints a
        WizardConnect pairing code and QR in your terminal, builds the same cancel, asks your paired wallet to
        sign it, and broadcasts it to a server you choose. It never asks for a private key. The docs page
        "Cancel an order by hand" describes the transaction byte by byte.
      </p>
    </section>
  );
}

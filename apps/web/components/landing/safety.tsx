import { DropIcon, LifebuoyIcon, LockKeyIcon, WalletIcon } from '@phosphor-icons/react/dist/ssr';
import type { Icon as PhosphorIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { CONTROL_TRANSITION } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Band, SECTION_HEADING } from './section';

/** The footer's `How funds are protected` link lands here (`/#limits`). */
export const LIMITS_ID = 'limits';

const LINK = cn('text-link underline underline-offset-4', CONTROL_TRANSITION);

const CARDS: readonly { readonly icon: PhosphorIcon; readonly title: string; readonly body: ReactNode }[] = [
  {
    icon: LockKeyIcon,
    title: 'Minimum price enforced on chain',
    body: 'The contract rejects any fill that pays your address less than your minimum. The check runs inside the transaction, not on AtPrice’s server.',
  },
  {
    icon: DropIcon,
    title: 'Only genuine Cauldron pools',
    body: 'A fill has to spend a real Cauldron pool for your token through its trade path. A look-alike contract, or a pool for another token, is rejected.',
  },
  {
    icon: WalletIcon,
    title: 'Cancel any time with your wallet',
    body: 'No expiry and no lock-up. Your wallet signs a cancel and the order’s funds come back to you, less a network fee that the order caps.',
  },
  {
    icon: LifebuoyIcon,
    title: 'Recover without AtPrice’s servers',
    body: (
      <>
        Recover is one self-contained page that reads the chain directly. If AtPrice is offline, you can still
        find and cancel your orders.{' '}
        <Link href="/recover" className={LINK}>
          Open Recover
        </Link>
      </>
    ),
  },
];

export function Safety() {
  return (
    <Band labelledBy={LIMITS_ID} className="flex flex-col gap-10">
      <div className="flex max-w-[64ch] flex-col gap-3">
        <h2 id={LIMITS_ID} tabIndex={-1} className={SECTION_HEADING}>
          Your keys, your exit
        </h2>
        <p className="text-body text-fg-secondary">
          AtPrice never holds your funds. The rules live in the order contract, and no AtPrice key can move
          what is in it.
        </p>
      </div>
      <ul className="grid gap-4 md:grid-cols-2 md:gap-6">
        {CARDS.map(({ icon: Icon, title, body }) => (
          <li
            key={title}
            className="flex flex-col gap-3 rounded-lg border border-border p-(--space-panel) lg:p-(--space-panel-lg)"
          >
            <Icon aria-hidden="true" weight="duotone" className="size-10 text-brand duotone-brand-subtle" />
            <h3 className="font-display text-heading-3 text-fg">{title}</h3>
            <p className="text-body text-fg-secondary">{body}</p>
          </li>
        ))}
      </ul>
    </Band>
  );
}

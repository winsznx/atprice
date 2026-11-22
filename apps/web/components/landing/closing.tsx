import { cauldronTradeFee, DEFAULT_MAX_NETWORK_FEE, MAX_NETWORK_FEE_CEILING } from '@atprice/core';
import { MinusIcon, PlusIcon } from '@phosphor-icons/react/dist/ssr';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { buttonVariants, CONTROL_TRANSITION } from '@/components/ui/button';
import { formatPercent, formatSats } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Band, SECTION_HEADING } from './section';

export const CTA_ID = 'start';
export const FAQ_ID = 'faq';

export function FinalCta() {
  return (
    <Band labelledBy={CTA_ID} tone="brand" className="flex flex-col items-start gap-6 md:flex-row md:items-center md:justify-between">
      <div className="flex max-w-[48ch] flex-col gap-3">
        <h2 id={CTA_ID} className={SECTION_HEADING}>
          Name your price, then get on with your day
        </h2>
        <p className="text-body text-fg-secondary">
          Funding takes one signature. The order waits in its contract until a pool meets it or you cancel.
        </p>
      </div>
      <div className="flex w-full flex-col gap-3 xs:w-auto xs:flex-row xs:flex-wrap">
        <Link href="/trade" className={buttonVariants({ variant: 'primary' })}>
          Place a limit order
        </Link>
        <Link href="/evidence" className={buttonVariants({ variant: 'outline' })}>
          See a real fill
        </Link>
      </div>
    </Band>
  );
}

const sat = (value: bigint): string => `${formatSats(value)} sat`;

/** Cauldron's fee from core's pool maths, not typed in. `fee-disclosure.tsx` is a client module, so this server file derives it the same way. */
const FEE_SAMPLE = 1_000_000n;
const poolFeePercent = (): string => formatPercent(cauldronTradeFee(FEE_SAMPLE), FEE_SAMPLE);

const FAQS: readonly { readonly question: string; readonly answer: ReactNode }[] = [
  {
    question: 'What does it cost?',
    answer: (
      <>
        AtPrice charges <span className="num">0%</span> in this pilot, and the contract has no fee output, so no
        AtPrice fee can be taken. You pay the network fee for the funding transaction from your wallet. The
        fill’s network fee is paid from the order and capped by the contract at the maxNetworkFee you agree to
        when you create it: <span className="num">{sat(DEFAULT_MAX_NETWORK_FEE)}</span> on AtPrice orders, and
        never more than <span className="num">{sat(MAX_NETWORK_FEE_CEILING)}</span> for any order. Cauldron’s
        pool fee of <span className="num">{poolFeePercent()}</span> is part of the pool’s price.
      </>
    ),
  },
  {
    question: 'What happens if the price never comes?',
    answer:
      'Nothing is lost. Orders are good till cancelled, so yours stays open with the funds in its contract until a pool can fill it or you cancel. There is no expiry, and cancelling returns the funds less a capped network fee.',
  },
  {
    question: 'Can the keeper take my funds?',
    answer:
      'No. A fill has one allowed shape: the pool and your order go in, the pool continued and your payout come out. The contract rejects any other output, any payout to another address, any payout below your minimum and any network fee above the cap. The keeper has no key, input or output in that transaction, so all it can do is send the fill that pays you.',
  },
  {
    question: 'Which wallets work?',
    answer:
      'Wallets that support WizardConnect, including Paytaca, Selene and Cashonize. You pair by scanning a QR code. Your keys stay in your wallet, and each transaction is shown there for you to approve.',
  },
  {
    question: 'What is Cauldron?',
    answer:
      'Cauldron is a decentralized exchange on Bitcoin Cash. Each pool is a contract holding BCH and one CashToken, priced by a constant-product formula, and anyone can trade against it. AtPrice fills your order through one of these pools.',
  },
  {
    question: 'Why one pool per fill, and what is fill-or-kill?',
    answer:
      'The contract settles against exactly one Cauldron pool, so an order is never split across pools. Fill-or-kill means the whole amount trades in one transaction or nothing trades and the order stays open. If no single pool is deep enough to pay your minimum for the whole amount, the order waits.',
  },
];

export function Faq() {
  return (
    <Band labelledBy={FAQ_ID} className="grid gap-8 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:gap-12">
      <h2 id={FAQ_ID} className={SECTION_HEADING}>
        Questions
      </h2>
      <div className="flex flex-col border-t border-border">
        {FAQS.map(({ question, answer }) => (
          <details key={question} className="group border-b border-border">
            <summary
              className={cn(
                'flex min-h-(--size-control) cursor-pointer list-none items-center justify-between gap-4 py-4 text-body font-semibold text-fg hover:text-link [&::-webkit-details-marker]:hidden',
                CONTROL_TRANSITION,
              )}
            >
              {question}
              <PlusIcon aria-hidden="true" className="size-5 shrink-0 text-fg-muted group-open:hidden" />
              <MinusIcon aria-hidden="true" className="hidden size-5 shrink-0 text-fg-muted group-open:block" />
            </summary>
            <p className="max-w-[64ch] pb-5 text-body text-fg-secondary">{answer}</p>
          </details>
        ))}
      </div>
    </Band>
  );
}

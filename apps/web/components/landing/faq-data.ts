import { cauldronTradeFee, DEFAULT_MAX_NETWORK_FEE, MAX_NETWORK_FEE_CEILING } from '@atprice/core';
import { formatPercent, formatSats } from '@/lib/format';
import type { FaqItem } from '@/lib/structured-data';

/** Plain text, or a figure the page sets in tabular numerals (the `num` utility). */
export type FaqPart = string | { readonly num: string };

export interface FaqEntry {
  readonly question: string;
  readonly answer: readonly FaqPart[];
}

const sat = (value: bigint): string => `${formatSats(value)} sat`;

/** Cauldron's fee from core's pool maths, not typed in. `fee-disclosure.tsx` is a client module, so this server file derives it the same way. */
const FEE_SAMPLE = 1_000_000n;
const poolFeePercent = (): string => formatPercent(cauldronTradeFee(FEE_SAMPLE), FEE_SAMPLE);

/** The landing FAQ. The page and the FAQPage structured data both read it, so they can't drift apart. */
export const FAQS: readonly FaqEntry[] = [
  {
    question: 'What does it cost?',
    answer: [
      'AtPrice charges ',
      { num: '0%' },
      ' in this pilot, and the contract has no fee output, so no AtPrice fee can be taken. You pay the network fee for the funding transaction from your wallet. The fill’s network fee is paid from the order and capped by the contract at the maxNetworkFee you agree to when you create it: ',
      { num: sat(DEFAULT_MAX_NETWORK_FEE) },
      ' on AtPrice orders, and never more than ',
      { num: sat(MAX_NETWORK_FEE_CEILING) },
      ' for any order. Cauldron’s pool fee of ',
      { num: poolFeePercent() },
      ' is part of the pool’s price.',
    ],
  },
  {
    question: 'What happens if the price never comes?',
    answer: [
      'Nothing is lost. Orders are good till cancelled, so yours stays open with the funds in its contract until a pool can fill it or you cancel. There is no expiry, and cancelling returns the funds less a capped network fee.',
    ],
  },
  {
    question: 'Can the keeper take my funds?',
    answer: [
      'No. A fill has one allowed shape: the pool and your order go in, the pool continued and your payout come out. The contract rejects any other output, any payout to another address, any payout below your minimum and any network fee above the cap. The keeper has no key, input or output in that transaction, so all it can do is send the fill that pays you.',
    ],
  },
  {
    question: 'Which wallets work?',
    answer: [
      'Wallets that support WizardConnect, including Paytaca, Selene and Cashonize. You pair by scanning a QR code. Your keys stay in your wallet, and each transaction is shown there for you to approve.',
    ],
  },
  {
    question: 'What is Cauldron?',
    answer: [
      'Cauldron is a decentralized exchange on Bitcoin Cash. Each pool is a contract holding BCH and one CashToken, priced by a constant-product formula, and anyone can trade against it. AtPrice fills your order through one of these pools.',
    ],
  },
  {
    question: 'How does a fill happen?',
    answer: [
      'Your whole order trades in one transaction through a single Cauldron pool, so the price you get is the price you see, with no partial fills to track. AtPrice’s keeper picks the pool that pays you the most.',
    ],
  },
];

export const faqAnswerText = (answer: readonly FaqPart[]): string =>
  answer.map((part) => (typeof part === 'string' ? part : part.num)).join('');

export const faqItems = (): readonly FaqItem[] =>
  FAQS.map(({ question, answer }) => ({ question, answer: faqAnswerText(answer) }));

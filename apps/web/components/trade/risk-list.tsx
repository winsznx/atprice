import { cn } from '@/lib/utils';

/**
 * trade.md "Before you fund" and funding-confirmation.md "Before you sign": the same lines, always
 * visible, never collapsible. The first four restate contract.md "Limits stated to users".
 */
export const RISK_LINES = [
  'Your funds stay locked in the order contract until it fills or you cancel. Orders don’t expire.',
  'One pool per fill and fill or kill: the whole amount trades through a single Cauldron pool, or nothing happens.',
  'Fills need a Cauldron pool for this token. If no pool exists or none can pay your minimum, the order waits.',
  'Anyone can fill your order once one pool pays your minimum, and a filler may pay exactly your minimum. AtPrice’s keeper uses the best single public pool, but the contract guarantees only your minimum, not a better price.',
  'The rate may never reach your limit.',
  'If AtPrice’s keeper is offline, your order fills only if someone else fills it. You can still cancel at any time, from Recover if AtPrice’s site is down.',
  'The contract is not independently audited.',
] as const;

export function RiskList({
  title,
  headingId,
  extra,
  headingLevel = 'h2',
  className,
}: {
  title: 'Before you fund' | 'Before you sign';
  headingId: string;
  /** A line specific to this order, such as the no-pool-can-quote warning, shown first. */
  extra?: string | null | undefined;
  headingLevel?: 'h2' | 'h3' | undefined;
  className?: string | undefined;
}) {
  const Heading = headingLevel;
  return (
    <section aria-labelledby={headingId} className={cn('flex flex-col gap-3', className)}>
      <Heading id={headingId} className="font-display text-heading-3 text-fg">
        {title}
      </Heading>
      <ul className="flex list-disc flex-col gap-2 pl-5 text-body-sm text-fg-secondary marker:text-fg-muted">
        {extra === null || extra === undefined ? null : <li className="text-fg">{extra}</li>}
        {RISK_LINES.map((line) => (
          <li key={line} className="max-w-[64ch]">
            {line}
          </li>
        ))}
      </ul>
    </section>
  );
}

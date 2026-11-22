import { cn } from '@/lib/utils';

/** What funding an order does, shown on the ticket and in the funding confirmation. */
export const RISK_LINES = [
  'Your funds sit in your own order contract until it fills or you cancel. Orders stay open until then.',
  'The whole amount trades in one transaction through a Cauldron pool, and you receive at least your minimum.',
  'AtPrice’s keeper checks every pool and fills your order through the best one the moment your price is there.',
  'Cancel any time with your wallet, from this site or from Recover.',
] as const;

export function RiskList({
  title,
  headingId,
  extra,
  headingLevel = 'h2',
  className,
}: {
  title: 'How your order works' | 'What you are signing';
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

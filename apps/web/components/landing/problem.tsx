import { ChartLineIcon, MoonStarsIcon, TimerIcon } from '@phosphor-icons/react/dist/ssr';
import type { Icon as PhosphorIcon } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { Band, SECTION_HEADING } from './section';

export const PROBLEM_ID = 'problem';

const PAINS: readonly { readonly icon: PhosphorIcon; readonly title: string; readonly text: string }[] = [
  {
    icon: ChartLineIcon,
    title: 'You watch the chart',
    text: 'A price you keep in your head only works while you are looking at it. The hours go to refreshing a pool page.',
  },
  {
    icon: MoonStarsIcon,
    title: 'The price arrives while you’re offline',
    text: 'Pools trade at night and over weekends. When the rate you wanted shows up, nobody is there to take it.',
  },
  {
    icon: TimerIcon,
    title: 'The quote moves before you sign',
    text: 'A swap is built against the pool as it was a moment ago. If the pool trades before your wallet signs, the swap fails or has to be rebuilt at the new rate.',
  },
];

interface Step {
  readonly text: string;
  readonly you: boolean;
}

const MANUAL: readonly Step[] = [
  { text: 'Decide the rate you want.', you: true },
  { text: 'Check the price, again and again.', you: true },
  { text: 'The rate arrives. You have to be there to see it.', you: true },
  { text: 'Build the swap and sign it in your wallet.', you: true },
  { text: 'If the pool moved first, rebuild and sign again.', you: true },
];

const ATPRICE: readonly Step[] = [
  { text: 'Set the rate and the amount.', you: true },
  { text: 'Sign once to fund the order contract.', you: true },
  { text: 'Close the tab. AtPrice’s keeper checks Cauldron pools.', you: false },
  { text: 'A single pool can pay at least your minimum for the whole order.', you: false },
  { text: 'One transaction pays your wallet. You sign nothing.', you: false },
];

function Timeline({ title, steps, footer, accent }: { title: string; steps: readonly Step[]; footer: string; accent: boolean }) {
  return (
    <div className={cn('flex flex-col gap-4 rounded-lg border bg-surface p-(--space-panel) lg:p-(--space-panel-lg)', accent ? 'border-brand' : 'border-border')}>
      <h3 className="font-display text-heading-3 text-fg">{title}</h3>
      <ol className="flex flex-col">
        {steps.map((step, index) => (
          <li key={step.text} className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-3">
            <span className="flex flex-col items-center">
              <span
                aria-hidden="true"
                className={cn(
                  'num flex size-7 shrink-0 items-center justify-center rounded-full text-caption font-semibold',
                  step.you ? 'bg-surface-muted text-fg' : 'bg-brand text-brand-fg',
                )}
              >
                {index + 1}
              </span>
              {index < steps.length - 1 ? <span aria-hidden="true" className="w-px flex-1 bg-border" /> : null}
            </span>
            <p className="pt-0.5 pb-4 text-body-sm text-fg-secondary">
              {step.text}
              <span className="sr-only">{step.you ? ' You do this.' : ' Happens without you.'}</span>
            </p>
          </li>
        ))}
      </ol>
      <p className="border-t border-border pt-3 text-body-sm text-fg">{footer}</p>
    </div>
  );
}

export function Problem() {
  return (
    <Band labelledBy={PROBLEM_ID} tone="sunken" className="flex flex-col gap-10">
      <div className="flex max-w-[64ch] flex-col gap-3">
        <h2 id={PROBLEM_ID} className={SECTION_HEADING}>
          A swap only happens while you’re watching
        </h2>
        <p className="text-body text-fg-secondary">
          Swapping on Bitcoin Cash today means being present at the moment the price is right.
        </p>
      </div>
      <ul className="grid gap-6 md:grid-cols-3">
        {PAINS.map(({ icon: Icon, title, text }) => (
          <li key={title} className="flex flex-col gap-2">
            <Icon aria-hidden="true" weight="duotone" className="size-8 text-fg-secondary duotone-surface-muted" />
            <h3 className="font-display text-heading-3 text-fg">{title}</h3>
            <p className="text-body text-fg-secondary">{text}</p>
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-4">
        <p className="flex flex-wrap items-center gap-x-5 gap-y-2 text-body-sm text-fg-muted">
          <span className="inline-flex items-center gap-2">
            <span aria-hidden="true" className="size-3 rounded-full bg-surface-muted ring-1 ring-border-input" />
            Steps you do
          </span>
          <span className="inline-flex items-center gap-2">
            <span aria-hidden="true" className="size-3 rounded-full bg-brand" />
            Steps that happen without you
          </span>
        </p>
        <div className="grid gap-4 md:grid-cols-2 md:gap-6">
          <Timeline title="A manual swap" steps={MANUAL} footer="You sign once per attempt, and only while you’re there." accent={false} />
          <Timeline title="An AtPrice order" steps={ATPRICE} footer="You sign once, to fund it. Cancelling takes one more signature." accent />
        </div>
      </div>
    </Band>
  );
}

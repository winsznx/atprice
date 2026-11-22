import { MinusIcon, PlusIcon } from '@phosphor-icons/react/dist/ssr';
import Link from 'next/link';
import { buttonVariants, CONTROL_TRANSITION } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { FAQS } from './faq-data';
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
            <p className="max-w-[64ch] pb-5 text-body text-fg-secondary">
              {answer.map((part, index) =>
                typeof part === 'string' ? (
                  part
                ) : (
                  <span key={index} className="num">
                    {part.num}
                  </span>
                ),
              )}
            </p>
          </details>
        ))}
      </div>
    </Band>
  );
}

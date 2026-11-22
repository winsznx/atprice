import type { ReactNode, RefObject } from 'react';

/**
 * A numbered step heading: the steps are a real sequence (server, find, order, cancel). It takes focus
 * (`tabindex="-1"`) when its step opens, and clears no header because the Recover header isn't sticky.
 */
export function SectionHeading({
  id,
  step,
  title,
  headingRef,
}: {
  id: string;
  step?: number | undefined;
  title: string;
  headingRef?: RefObject<HTMLHeadingElement | null> | undefined;
}) {
  return (
    <h2
      id={id}
      ref={headingRef}
      tabIndex={-1}
      className="flex scroll-mt-20 items-baseline gap-3 text-heading-3 text-fg focus-visible:outline-offset-4"
    >
      {step === undefined ? null : (
        <>
          <span className="sr-only">{`Step ${step} of 4, `}</span>
          <span
            aria-hidden="true"
            className="num inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-brand-subtle text-label font-semibold text-brand"
          >
            {step}
          </span>
        </>
      )}
      <span>{title}</span>
    </h2>
  );
}

/** A later step before the earlier one is complete: its heading and one line that says what opens it. */
export function CollapsedSection({
  id,
  step,
  title,
  summary,
}: {
  id: string;
  step: number;
  title: string;
  summary: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <SectionHeading id={id} step={step} title={title} />
      <p className="text-body-sm text-fg-muted">{summary}</p>
    </section>
  );
}

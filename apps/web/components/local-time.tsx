'use client';

import { useNow } from '@/lib/hooks/use-now';

const pad = (value: number): string => value.toString().padStart(2, '0');

/** `14:02:11` in the viewer's time zone after hydration; UTC (labelled) during server render. */
export const formatClock = (date: Date, local: boolean): string =>
  local
    ? `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    : `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} UTC`;

export const formatDateTime = (date: Date, local: boolean): string => {
  const day = local
    ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    : `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  return `${day} ${formatClock(date, local)}`;
};

/**
 * A timestamp that never causes a hydration mismatch: the server and the hydrating client render UTC,
 * then the client switches to local time on the first clock tick.
 */
export function LocalTime({
  iso,
  withDate = false,
  className,
}: {
  iso: string;
  withDate?: boolean | undefined;
  className?: string | undefined;
}) {
  const hydrated = useNow() !== null;
  const date = new Date(iso);
  return (
    <time dateTime={iso} className={`num ${className ?? ''}`}>
      {withDate ? formatDateTime(date, hydrated) : formatClock(date, hydrated)}
    </time>
  );
}

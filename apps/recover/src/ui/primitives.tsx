import { ArrowSquareOutIcon, CheckIcon, CopyIcon } from '@phosphor-icons/react/dist/ssr';
import qrcode from 'qrcode-generator';
import { useEffect, useMemo, useRef, useState, type ComponentProps, type MouseEvent, type ReactNode } from 'react';
import { truncateMiddle } from '../../../web/lib/format';

/** An outpoint as the chip shows it: the txid truncated, the output index kept. */
export const outpointDisplay = (txid: string, vout: number): string => `${txid.slice(0, 8)}…${txid.slice(-6)}:${vout}`;

export const cx = (...classes: (string | false | null | undefined)[]): string => classes.filter(Boolean).join(' ');

/** M-01: colour properties only, so the focus outline is never transitioned (motion.md rule 7). */
export const CONTROL_TRANSITION =
  'transition-[color,background-color,border-color,text-decoration-color] duration-(--duration-fast) ease-move';

const BUTTON_BASE = cx(
  'inline-flex shrink-0 items-center justify-center gap-2 rounded-md font-sans text-body font-semibold select-none text-center',
  '[&_svg]:pointer-events-none [&_svg]:size-5 [&_svg]:shrink-0',
  CONTROL_TRANSITION,
  'aria-disabled:cursor-not-allowed aria-disabled:bg-surface-muted aria-disabled:text-fg-disabled aria-disabled:shadow-none aria-disabled:border-transparent',
);

const BUTTON_VARIANT = {
  primary: 'bg-brand text-brand-fg shadow-inset hover:bg-brand-hover active:bg-brand-hover',
  outline: 'border border-border-input bg-surface text-fg hover:bg-surface-sunken active:bg-surface-sunken',
  ghost: 'text-fg-secondary hover:bg-surface-sunken active:bg-surface-sunken',
  destructive: 'bg-status-failed text-brand-fg shadow-inset hover:bg-status-failed-hover active:bg-status-failed-hover',
} as const;

export type ButtonVariant = keyof typeof BUTTON_VARIANT;

export const buttonClass = (variant: ButtonVariant, compact = false): string =>
  cx(BUTTON_BASE, BUTTON_VARIANT[variant], compact ? 'min-h-10 px-4 text-label font-semibold' : 'min-h-(--size-control) px-5');

/**
 * DD 7.1. A control that must keep its reason reachable uses `aria-disabled` plus `aria-describedby`
 * on the visible reason; clicks are swallowed here so no caller can forget.
 */
export function Button({
  variant = 'primary',
  compact = false,
  className,
  onClick,
  ...props
}: ComponentProps<'button'> & { variant?: ButtonVariant; compact?: boolean }) {
  const disabled = props['aria-disabled'] === true || props['aria-disabled'] === 'true';
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (disabled) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };
  return <button type="button" className={cx(buttonClass(variant, compact), className)} onClick={handleClick} {...props} />;
}

export function DisabledReason({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="text-body-sm text-fg-muted">
      {children}
    </p>
  );
}

const COPIED_HOLD_MS = 1_500;

type CopyState = 'idle' | 'copied' | 'failed';

/** Copies `value`, holds the Check icon 1.5 s (M-09) and reports a blocked clipboard honestly (DD 7.11). */
export function useCopy(value: string): { state: CopyState; copy: () => Promise<boolean> } {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async (): Promise<boolean> => {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
      timer.current = setTimeout(() => setState('idle'), COPIED_HOLD_MS);
      return true;
    } catch (error) {
      console.warn('Clipboard write failed:', error);
      setState('failed');
      return false;
    }
  };
  return { state, copy };
}

const selectText = (element: HTMLElement | null): void => {
  if (element === null) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
};

function CopyIcons({ state }: { state: CopyState }) {
  return (
    <>
      <CopyIcon
        aria-hidden="true"
        className={cx(
          'absolute size-4 motion-safe:transition-opacity motion-safe:duration-(--duration-fast) ease-move',
          state === 'copied' ? 'opacity-0' : 'opacity-100',
        )}
      />
      <CheckIcon
        aria-hidden="true"
        className={cx(
          'absolute size-4 motion-safe:transition-opacity motion-safe:duration-(--duration-fast) ease-move',
          state === 'copied' ? 'opacity-100' : 'opacity-0',
        )}
      />
    </>
  );
}

function CopyStatus({ state }: { state: CopyState }) {
  return (
    <span role="status" aria-live="polite" className={state === 'failed' ? 'text-body-sm text-status-failed' : 'sr-only'}>
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed. Select the text instead.' : ''}
    </span>
  );
}

export type HashKind = 'tx' | 'address' | 'token' | 'outpoint' | 'keyhash' | 'link' | 'hash';

const NOUN: Readonly<Record<HashKind, string>> = {
  tx: 'transaction id',
  address: 'address',
  token: 'token category',
  outpoint: 'outpoint',
  keyhash: 'key hash',
  link: 'pairing link',
  hash: 'file hash',
};

export interface ExplorerTarget {
  readonly href: string;
  /** Accessible name, ending with "opens in a new tab" (DD 7.12). */
  readonly label: string;
}

/**
 * DD 7.11 hash chip: mono on sunken, middle truncation (first 8, last 6, prefix dropped in the chip and
 * kept in the copied value), a copy button and, where an explorer has a page, an explorer link.
 */
export function HashChip({
  value,
  kind,
  explorer,
  full = false,
  label,
  copyLabel,
  display,
}: {
  value: string;
  kind: HashKind;
  /** What the chip shows instead of the middle-truncated value (a pairing link keeps its scheme). */
  display?: string | undefined;
  explorer?: ExplorerTarget | null | undefined;
  full?: boolean | undefined;
  label?: string | undefined;
  copyLabel?: string | undefined;
}) {
  const { state, copy } = useCopy(value);
  const textRef = useRef<HTMLSpanElement>(null);
  const noun = NOUN[kind];
  const shown = full || state === 'failed' ? value : (display ?? truncateMiddle(value));
  const onCopy = async () => {
    if (!(await copy())) requestAnimationFrame(() => selectText(textRef.current));
  };
  return (
    <span className="inline-flex max-w-full flex-col gap-1">
      <span
        role="group"
        aria-label={label ?? `${noun} ${value}`}
        className="inline-flex max-w-full min-h-8 items-center gap-1 rounded-sm bg-surface-sunken pl-2 text-mono-sm text-fg"
      >
        <span
          ref={textRef}
          className={cx('hash min-w-0 py-1', full || state === 'failed' ? 'whitespace-normal' : 'whitespace-nowrap')}
          title={full ? undefined : value}
        >
          {shown}
        </span>
        <button
          type="button"
          onClick={onCopy}
          aria-label={copyLabel ?? `Copy ${noun}`}
          className={cx(
            'relative inline-flex size-9 shrink-0 items-center justify-center rounded-sm text-fg-muted hover:bg-surface-muted hover:text-fg',
            CONTROL_TRANSITION,
          )}
        >
          <CopyIcons state={state} />
        </button>
        {explorer ? (
          <a
            href={explorer.href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={explorer.label}
            className={cx(
              'inline-flex size-9 shrink-0 items-center justify-center rounded-sm text-fg-muted hover:bg-surface-muted hover:text-fg',
              CONTROL_TRANSITION,
            )}
          >
            <ArrowSquareOutIcon aria-hidden="true" className="size-4" />
          </a>
        ) : null}
      </span>
      <CopyStatus state={state} />
    </span>
  );
}

/** A button that copies a long text value (`Copy parameters (JSON)`, `Copy unsigned tx`). */
export function CopyTextButton({
  value,
  children,
  disabledReason,
  reasonId,
}: {
  value: string | null;
  children: ReactNode;
  disabledReason?: string | undefined;
  reasonId: string;
}) {
  const { state, copy } = useCopy(value ?? '');
  const disabled = value === null;
  return (
    <span className="flex flex-col gap-1">
      <Button
        variant="outline"
        aria-disabled={disabled || undefined}
        aria-describedby={disabled && disabledReason !== undefined ? reasonId : undefined}
        onClick={() => void copy()}
      >
        <span className="relative inline-flex size-5 items-center justify-center">
          <CopyIcons state={state} />
        </span>
        {children}
      </Button>
      {disabled && disabledReason !== undefined ? <DisabledReason id={reasonId}>{disabledReason}</DisabledReason> : null}
      <CopyStatus state={state} />
    </span>
  );
}

const QUIET_ZONE = 4;
const ALPHANUMERIC = /^[0-9A-Z $%*+\-./:]+$/;

/** A QR code as one SVG path in `--color-fg` on `--color-surface`, quiet zone of 4 modules (DD 7.8). */
export function QrCode({ value, size, label }: { value: string; size: number; label: string }) {
  const { path, modules } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value, ALPHANUMERIC.test(value) ? 'Alphanumeric' : 'Byte');
    qr.make();
    const count = qr.getModuleCount();
    const segments: string[] = [];
    for (let row = 0; row < count; row += 1) {
      for (let col = 0; col < count; col += 1) {
        if (qr.isDark(row, col)) segments.push(`M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`);
      }
    }
    return { path: segments.join(''), modules: count + QUIET_ZONE * 2 };
  }, [value]);
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${modules} ${modules}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className="max-w-full shrink-0 rounded-sm bg-surface"
    >
      <rect width={modules} height={modules} className="fill-surface" />
      <path d={path} className="fill-fg" />
    </svg>
  );
}

export type Tone = 'open' | 'pending' | 'filled' | 'cancelled' | 'failed' | 'review';

const TONE: Readonly<Record<Tone, string>> = {
  open: 'bg-status-open-subtle text-status-open',
  pending: 'bg-status-pending-subtle text-status-pending',
  filled: 'bg-status-filled-subtle text-status-filled',
  cancelled: 'bg-status-cancelled-subtle text-status-cancelled',
  failed: 'bg-status-failed-subtle text-status-failed',
  review: 'bg-status-review-subtle text-status-review',
};

/** DD 7.15 status badge: a tinted pill with text, so status never depends on colour alone. */
export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={cx('inline-flex min-h-6 items-center rounded-full px-2.5 text-caption font-semibold', TONE[tone])}>
      {children}
    </span>
  );
}

/** DD 7.13 error block: what failed, the named code in mono, and never disappears on its own. */
export function ErrorBlock({
  message,
  code,
  detail,
  children,
}: {
  message: ReactNode;
  code: string;
  detail?: string | undefined;
  children?: ReactNode;
}) {
  const showCode = typeof message !== 'string' || !message.includes(code);
  return (
    <div role="alert" className="flex flex-col gap-2 rounded-md border border-status-failed bg-status-failed-subtle p-4">
      <p className="text-body-sm text-fg">{message}</p>
      {showCode ? <p className="hash text-mono-sm text-status-failed">{code}</p> : null}
      {detail === undefined ? null : <p className="hash text-mono-sm text-fg-secondary">{detail}</p>}
      {children}
    </div>
  );
}

/** A labelled row of section 3 and 4: label column, value column, stacked below md. */
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 py-2 md:grid-cols-[9rem_minmax(0,1fr)] md:gap-4">
      <dt className="text-label text-fg-muted">{label}</dt>
      <dd className="flex min-w-0 flex-col gap-1 text-body text-fg">{children}</dd>
    </div>
  );
}

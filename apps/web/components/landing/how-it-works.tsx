import { Band, SECTION_HEADING } from './section';

export const HOW_IT_WORKS_ID = 'how-it-works';

const STEPS: readonly { readonly title: string; readonly text: string }[] = [
  {
    title: 'Set your price and amount',
    text: 'Pick a market, the amount and the rate you want. You see the minimum you will receive before you sign anything.',
  },
  {
    title: 'Fund the order contract from your wallet',
    text: 'One signature locks the amount in a contract made for this order, with its terms written on chain beside it.',
  },
  {
    title: 'The keeper watches Cauldron pools',
    text: 'AtPrice’s keeper looks for a single pool that pays at least your minimum for the whole order. You can close the tab.',
  },
  {
    title: 'One transaction pays you',
    text: 'The fill spends the pool and your order together and sends the payout straight to your wallet. It needs no signature from you.',
  },
];

interface DiagramBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly label: string;
  readonly lines: readonly string[];
  readonly tone: 'pool' | 'order' | 'payout';
}

const TONE: Readonly<Record<DiagramBox['tone'], string>> = {
  pool: 'fill-surface stroke-border-strong',
  order: 'fill-brand-subtle stroke-brand',
  payout: 'fill-status-filled-subtle stroke-status-filled',
};

function Box({ box }: { box: DiagramBox }) {
  const cx = box.x + box.w / 2;
  const top = box.y + box.h / 2 - (box.lines.length * 18) / 2;
  return (
    <g>
      <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={12} strokeWidth={1.5} className={TONE[box.tone]} />
      <text x={cx} y={top} textAnchor="middle" className="num fill-fg-muted font-sans text-[12px] font-medium">
        {box.label}
      </text>
      {box.lines.map((line, index) => (
        <text key={line} x={cx} y={top + 20 + index * 18} textAnchor="middle" className="fill-fg font-sans text-[15px] font-semibold">
          {line}
        </text>
      ))}
    </g>
  );
}

function Arrow({ d, marker }: { d: string; marker: string }) {
  return <path d={d} fill="none" strokeWidth={2} strokeLinecap="round" markerEnd={`url(#${marker})`} className="stroke-border-strong" />;
}

function ArrowMarker({ id }: { id: string }) {
  return (
    <defs>
      <marker id={id} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0 0 L10 5 L0 10 z" className="fill-border-strong" />
      </marker>
    </defs>
  );
}

function TxBox({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={16} strokeWidth={1.5} className="fill-surface-sunken stroke-border-input" />
      <text x={cx} y={cy - 4} textAnchor="middle" className="fill-fg font-sans text-[15px] font-semibold">
        Settlement
      </text>
      <text x={cx} y={cy + 16} textAnchor="middle" className="fill-fg font-sans text-[15px] font-semibold">
        transaction
      </text>
    </g>
  );
}

/** Wide layout (md and up): inputs on the left, outputs on the right, the transaction between them. */
function WideDiagram() {
  const boxes: readonly DiagramBox[] = [
    { x: 8, y: 20, w: 196, h: 84, label: 'Input 0', lines: ['Cauldron pool'], tone: 'pool' },
    { x: 8, y: 156, w: 196, h: 84, label: 'Input 1', lines: ['Your order contract'], tone: 'order' },
    { x: 516, y: 20, w: 196, h: 84, label: 'Output 0', lines: ['Pool, continued'], tone: 'pool' },
    { x: 516, y: 156, w: 196, h: 84, label: 'Output 1', lines: ['Your tokens,', 'to your wallet'], tone: 'payout' },
  ];
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 720 260" className="hidden h-auto w-full md:block">
      <ArrowMarker id="tx-arrow-wide" />
      <Arrow d="M204 62 C 240 62 244 104 276 104" marker="tx-arrow-wide" />
      <Arrow d="M204 198 C 240 198 244 156 276 156" marker="tx-arrow-wide" />
      <Arrow d="M444 104 C 476 104 480 62 512 62" marker="tx-arrow-wide" />
      <Arrow d="M444 156 C 476 156 480 198 512 198" marker="tx-arrow-wide" />
      <TxBox x={280} y={70} w={160} h={120} />
      {boxes.map((box) => (
        <Box key={box.label} box={box} />
      ))}
    </svg>
  );
}

/** Narrow layout (below md): inputs on top, outputs below, so text stays legible at 320px. */
function NarrowDiagram() {
  const boxes: readonly DiagramBox[] = [
    { x: 4, y: 4, w: 148, h: 80, label: 'Input 0', lines: ['Cauldron pool'], tone: 'pool' },
    { x: 168, y: 4, w: 148, h: 80, label: 'Input 1', lines: ['Your order', 'contract'], tone: 'order' },
    { x: 4, y: 284, w: 148, h: 80, label: 'Output 0', lines: ['Pool,', 'continued'], tone: 'pool' },
    { x: 168, y: 284, w: 148, h: 80, label: 'Output 1', lines: ['Your tokens,', 'to your wallet'], tone: 'payout' },
  ];
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 320 368" className="h-auto w-full md:hidden">
      <ArrowMarker id="tx-arrow-narrow" />
      <Arrow d="M78 84 C 78 112 130 108 130 136" marker="tx-arrow-narrow" />
      <Arrow d="M242 84 C 242 112 190 108 190 136" marker="tx-arrow-narrow" />
      <Arrow d="M130 232 C 130 256 78 252 78 280" marker="tx-arrow-narrow" />
      <Arrow d="M190 232 C 190 256 242 252 242 280" marker="tx-arrow-narrow" />
      <TxBox x={80} y={140} w={160} h={88} />
      {boxes.map((box) => (
        <Box key={box.label} box={box} />
      ))}
    </svg>
  );
}

export function HowItWorks() {
  return (
    <Band labelledBy={HOW_IT_WORKS_ID} className="flex flex-col gap-10">
      <div className="flex max-w-[64ch] flex-col gap-3">
        <h2 id={HOW_IT_WORKS_ID} tabIndex={-1} className={SECTION_HEADING}>
          How it works
        </h2>
        <p className="text-body text-fg-secondary">
          Your order is a contract on Bitcoin Cash. It can only be spent in one shape of transaction, or by
          you to cancel.
        </p>
      </div>
      <div className="grid gap-10 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-start lg:gap-12">
        <figure className="flex flex-col gap-4 rounded-lg border border-border p-(--space-panel) lg:p-(--space-panel-lg)">
          <WideDiagram />
          <NarrowDiagram />
          <figcaption className="flex flex-col gap-2 text-body-sm text-fg-secondary">
            <span className="text-label font-semibold text-fg">The fill transaction, as the contract requires it</span>
            <span className="sr-only">
              Inputs: input 0 is the Cauldron pool, input 1 is your order contract. Outputs: output 0 is the
              pool, continued, output 1 is your tokens, paid to your wallet.
            </span>
            <span>
              Exactly two inputs and two outputs. There is no signature from you and no input, output or key
              for AtPrice. The contract checks that output 1 pays your address at least your minimum, and that
              the network fee stays within the cap you agreed to. A buy is shown. A sell pays BCH the same way.
            </span>
          </figcaption>
        </figure>
        <ol className="flex flex-col gap-6">
          {STEPS.map((step, index) => (
            <li key={step.title} className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-4">
              <span
                aria-hidden="true"
                className="num flex size-10 items-center justify-center rounded-full bg-brand-subtle text-num-md font-semibold text-brand"
              >
                {index + 1}
              </span>
              <div className="flex flex-col gap-1">
                <h3 className="font-display text-heading-3 text-fg">{step.title}</h3>
                <p className="text-body text-fg-secondary">{step.text}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </Band>
  );
}

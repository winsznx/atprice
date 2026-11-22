/**
 * DD 7.15 line motif, the page's only decorative graphic: a dotted level (your price), a price path
 * that meets it, and a dot where they meet. `slice` keeps the dot round and centred at every width.
 */
export function LineMotif({ className }: { className?: string | undefined }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 1200 64"
      preserveAspectRatio="xMidYMid slice"
      className={className}
      height={64}
      width="100%"
    >
      <line
        x1="0"
        y1="32"
        x2="1200"
        y2="32"
        className="stroke-border-strong"
        strokeWidth="2"
        strokeDasharray="2 8"
        strokeLinecap="round"
      />
      <path
        d="M0 56 C 90 54 130 18 210 22 S 330 58 410 50 S 500 12 548 20 S 584 34 600 32"
        className="fill-none stroke-chart-line"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="600" cy="32" r="6" className="fill-chart-line" />
    </svg>
  );
}

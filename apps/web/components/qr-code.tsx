import qrcode from 'qrcode-generator';
import { useMemo } from 'react';
import { cn } from '@/lib/utils';

const QUIET_ZONE = 4;

/**
 * A QR code drawn as one SVG path in `--color-fg` on `--color-surface`, quiet zone of 4 modules
 * (DD 7.8). `value` is encoded as given, so the WizardConnect `qrUri` keeps its alphanumeric mode.
 */
export function QrCode({
  value,
  size,
  label,
  className,
}: {
  value: string;
  size: number;
  label: string;
  className?: string | undefined;
}) {
  const { path, modules } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value, /^[0-9A-Z $%*+\-./:]+$/.test(value) ? 'Alphanumeric' : 'Byte');
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
      className={cn('shrink-0 rounded-sm bg-surface', className)}
    >
      <rect width={modules} height={modules} className="fill-surface" />
      <path d={path} className="fill-fg" />
    </svg>
  );
}

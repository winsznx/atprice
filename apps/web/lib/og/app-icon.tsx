import { ImageResponse } from 'next/og';
import { MARK_DATA_URI, OG_COLOURS } from './theme';

export type AppIconVariant = 'any' | 'maskable' | 'apple';

/**
 * The share of the canvas the mark fills. `any` is the mark as drawn, rounded corners and all. `apple`
 * sits on a full brand square because iOS fills transparent corners with black and rounds the icon
 * itself. `maskable` shrinks the mark so its strokes stay inside the 80% safe circle a launcher may crop to.
 */
const MARK_SCALE: Readonly<Record<AppIconVariant, number>> = { any: 1, apple: 1, maskable: 0.8 };

/** A square PNG of the DD 2 mark, rendered from `app/icon.svg` at `size` pixels. */
export function renderAppIcon(size: number, variant: AppIconVariant): ImageResponse {
  const markSize = Math.round(size * MARK_SCALE[variant]);
  return new ImageResponse(
    (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          height: '100%',
          background: variant === 'any' ? 'transparent' : OG_COLOURS.brand,
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- Satori renders plain img elements only. */}
        <img alt="" height={markSize} src={MARK_DATA_URI} width={markSize} />
      </div>
    ),
    { width: size, height: size },
  );
}

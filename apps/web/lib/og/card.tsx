import { ImageResponse } from 'next/og';
import { MARK_DATA_URI, OG_COLOURS, OG_FONTS, ogToneColours, type OgTone } from './theme';

const DESCRIPTION_LIMIT = 120;
const DISPLAY_FONT = '"Bricolage Grotesque", "Geist Symbols"';
const TEXT_FONT = 'Inter, "Geist Symbols"';

export interface OgCard {
  readonly title: string;
  readonly description?: string | undefined;
  /** Small tag next to the wordmark, such as `Market`. */
  readonly label?: string | undefined;
  /** Status chip above the title, in the page's status colours. */
  readonly status?: { readonly tone: OgTone; readonly label: string } | undefined;
  /** Path shown after atprice.cash in the bottom band, such as `/evidence`. */
  readonly path: string;
  /** Right side of the bottom band: what the page is. */
  readonly note: string;
}

/** Two lines at most: shorter titles get a larger size. */
const titleSize = (title: string): number => {
  if (title.length <= 16) return 108;
  if (title.length <= 26) return 92;
  if (title.length <= 36) return 78;
  return 66;
};

export const fitDescription = (text: string): string => {
  if (text.length <= DESCRIPTION_LIMIT) return text;
  const cut = text.slice(0, DESCRIPTION_LIMIT);
  return `${cut.slice(0, cut.lastIndexOf(' ')).replace(/[,.:;]$/, '')}…`;
};

/** The 1200 x 630 share card every route uses: lockup, title, one sentence, and the address band. */
export function renderOgCard({ title, description, label, status, path, note }: OgCard): ImageResponse {
  const tone = status === undefined ? null : ogToneColours(status.tone);
  return new ImageResponse(
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        background: OG_COLOURS.surface,
        fontFamily: TEXT_FONT,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, padding: '60px 72px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- Satori renders plain img elements only. */}
          <img alt="" height={56} src={MARK_DATA_URI} width={56} />
          <div
            style={{
              display: 'flex',
              marginLeft: 20,
              fontFamily: DISPLAY_FONT,
              fontSize: 42,
              letterSpacing: '-0.025em',
              color: OG_COLOURS.fg,
            }}
          >
            <span style={{ fontWeight: 400 }}>At</span>
            <span style={{ fontWeight: 600 }}>Price</span>
          </div>
          {label === undefined ? null : (
            <div
              style={{
                display: 'flex',
                marginLeft: 20,
                padding: '6px 16px',
                borderRadius: 999,
                background: OG_COLOURS.brandSubtle,
                color: OG_COLOURS.brand,
                fontSize: 24,
                fontWeight: 600,
              }}
            >
              {label}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 'auto', marginBottom: 52 }}>
          {status === undefined || tone === null ? null : (
            <div style={{ display: 'flex', marginBottom: 24 }}>
              <div
                style={{
                  display: 'flex',
                  padding: '6px 18px',
                  borderRadius: 999,
                  background: tone.bg,
                  color: tone.fg,
                  fontSize: 26,
                  fontWeight: 600,
                }}
              >
                {status.label}
              </div>
            </div>
          )}
          <div
            style={{
              display: 'flex',
              maxWidth: 1056,
              fontFamily: DISPLAY_FONT,
              fontSize: titleSize(title),
              fontWeight: 600,
              lineHeight: 1.08,
              letterSpacing: '-0.025em',
              color: OG_COLOURS.fg,
              textWrap: 'balance',
            }}
          >
            {title}
          </div>
          {description === undefined ? null : (
            <div
              style={{
                display: 'flex',
                maxWidth: 1000,
                marginTop: 22,
                fontSize: 30,
                fontWeight: 500,
                lineHeight: 1.4,
                color: OG_COLOURS.fgSecondary,
                textWrap: 'balance',
              }}
            >
              {fitDescription(description)}
            </div>
          )}
        </div>
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          height: 84,
          padding: '0 72px',
          background: OG_COLOURS.brand,
          fontSize: 26,
          fontWeight: 600,
        }}
      >
        <div style={{ display: 'flex', color: OG_COLOURS.brandFg }}>
          atprice.cash
          <span style={{ color: OG_COLOURS.focusInverse }}>{path === '/' ? '' : path}</span>
        </div>
        <div style={{ display: 'flex', color: OG_COLOURS.focusInverse }}>{note}</div>
      </div>
    </div>,
    { width: 1200, height: 630, fonts: OG_FONTS },
  );
}

import { renderAppIcon, type AppIconVariant } from '@/lib/og/app-icon';

/** The PWA manifest's icons (app/manifest.ts), rendered from the mark at build. */
const ICONS: Readonly<Record<string, { readonly size: number; readonly variant: AppIconVariant }>> = {
  'icon-192.png': { size: 192, variant: 'any' },
  'icon-512.png': { size: 512, variant: 'any' },
  'icon-maskable-512.png': { size: 512, variant: 'maskable' },
};

export const dynamicParams = false;

export function generateStaticParams(): { name: string }[] {
  return Object.keys(ICONS).map((name) => ({ name }));
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ name: string }> },
): Promise<Response> {
  const icon = ICONS[(await params).name];
  if (icon === undefined) return new Response('Not found', { status: 404 });
  return renderAppIcon(icon.size, icon.variant);
}

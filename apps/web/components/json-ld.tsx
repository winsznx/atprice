import { headers } from 'next/headers';
import { serializeJsonLd } from '@/lib/structured-data';

/**
 * Structured data for search engines. Browsers never run an `application/ld+json` block, but it still
 * carries proxy.ts's per-request nonce so the page has no script element outside the CSP.
 */
export async function JsonLd({ data }: { readonly data: Readonly<Record<string, unknown>> }) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <script
      type="application/ld+json"
      nonce={nonce}
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    />
  );
}

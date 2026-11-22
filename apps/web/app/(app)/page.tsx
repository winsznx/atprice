import type { Metadata } from 'next';
import { JsonLd } from '@/components/json-ld';
import { Faq, FinalCta } from '@/components/landing/closing';
import { faqItems } from '@/components/landing/faq-data';
import { Hero } from '@/components/landing/hero';
import { HowItWorks } from '@/components/landing/how-it-works';
import { LiveProof } from '@/components/landing/live-proof';
import { Problem } from '@/components/landing/problem';
import { Safety } from '@/components/landing/safety';
import { HOME_DESCRIPTION, HOME_TITLE } from '@/lib/seo';
import { homeStructuredData } from '@/lib/structured-data';

/** `/` keeps the root layout's tags and share card (lib/seo.ts); only the title skips the template. */
export const metadata: Metadata = {
  title: { absolute: HOME_TITLE },
  description: HOME_DESCRIPTION,
  alternates: { canonical: '/' },
};

/** `/`: what AtPrice is, how a fill works, live proof from the chain, safety and questions. Trading lives on `/trade`. */
export default function HomeRoute() {
  return (
    <>
      <Hero />
      <Problem />
      <HowItWorks />
      <LiveProof />
      <Safety />
      <FinalCta />
      <Faq />
      <JsonLd data={homeStructuredData(faqItems())} />
    </>
  );
}

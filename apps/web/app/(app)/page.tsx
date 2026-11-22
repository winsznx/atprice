import type { Metadata } from 'next';
import { Faq, FinalCta } from '@/components/landing/closing';
import { Hero } from '@/components/landing/hero';
import { HowItWorks } from '@/components/landing/how-it-works';
import { LiveProof } from '@/components/landing/live-proof';
import { Problem } from '@/components/landing/problem';
import { Safety } from '@/components/landing/safety';

export const metadata: Metadata = {
  title: { absolute: 'AtPrice · Limit orders for Bitcoin Cash tokens' },
  description:
    'Set your price. Trade when the market meets it. Limit orders for CashTokens on Bitcoin Cash, filled through Cauldron pools.',
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
    </>
  );
}

import { HOME_DESCRIPTION, SITE_NAME, SITE_URL } from './seo';

export interface FaqItem {
  readonly question: string;
  readonly answer: string;
}

type JsonLdNode = Readonly<Record<string, unknown>>;

const WEBSITE_ID = `${SITE_URL}/#website`;
const ORGANIZATION_ID = `${SITE_URL}/#organization`;

const organization: JsonLdNode = {
  '@type': 'Organization',
  '@id': ORGANIZATION_ID,
  name: SITE_NAME,
  url: SITE_URL,
  logo: `${SITE_URL}/icons/icon-512.png`,
};

const website: JsonLdNode = {
  '@type': 'WebSite',
  '@id': WEBSITE_ID,
  name: SITE_NAME,
  url: SITE_URL,
  description: HOME_DESCRIPTION,
  inLanguage: 'en',
  publisher: { '@id': ORGANIZATION_ID },
};

const application: JsonLdNode = {
  '@type': 'SoftwareApplication',
  name: SITE_NAME,
  url: SITE_URL,
  description: HOME_DESCRIPTION,
  applicationCategory: 'FinanceApplication',
  operatingSystem: 'Web',
  isPartOf: { '@id': WEBSITE_ID },
  publisher: { '@id': ORGANIZATION_ID },
  offers: {
    '@type': 'Offer',
    price: '0',
    priceCurrency: 'USD',
    description:
      'No AtPrice fee during the pilot. You pay Bitcoin Cash network fees, and the Cauldron pool fee is part of the pool price.',
  },
};

const faqPage = (items: readonly FaqItem[]): JsonLdNode => ({
  '@type': 'FAQPage',
  mainEntity: items.map(({ question, answer }) => ({
    '@type': 'Question',
    name: question,
    acceptedAnswer: { '@type': 'Answer', text: answer },
  })),
});

/** The home page graph: who publishes the site, what the app is, and the landing FAQ word for word. */
export const homeStructuredData = (faq: readonly FaqItem[]): JsonLdNode => ({
  '@context': 'https://schema.org',
  '@graph': [organization, website, application, faqPage(faq)],
});

/**
 * JSON for an inline `<script type="application/ld+json">`. `JSON.stringify` leaves `<` alone, so a
 * value containing `</script>` could close the tag; escaping it keeps the payload inert.
 */
export const serializeJsonLd = (data: JsonLdNode): string => JSON.stringify(data).replace(/</g, '\\u003c');

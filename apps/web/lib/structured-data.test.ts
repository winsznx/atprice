import { describe, expect, it } from 'vitest';
import { homeStructuredData, serializeJsonLd } from './structured-data';

const FAQ = [{ question: 'What does it cost?', answer: 'AtPrice charges 0% in this pilot.' }];

describe('homeStructuredData', () => {
  it('describes the site, the app as a finance application and the FAQ in one graph', () => {
    // #when the home graph is built
    const data = homeStructuredData(FAQ);
    const graph = data['@graph'] as readonly Record<string, unknown>[];

    // #then each node is present with the fields search engines read
    expect(data['@context']).toBe('https://schema.org');
    expect(graph.map((node) => node['@type'])).toEqual(['Organization', 'WebSite', 'SoftwareApplication', 'FAQPage']);
    expect(graph[1]).toMatchObject({ name: 'AtPrice', url: 'https://atprice.cash' });
    expect(graph[2]).toMatchObject({
      applicationCategory: 'FinanceApplication',
      operatingSystem: 'Web',
      offers: { '@type': 'Offer', price: '0' },
    });
    expect(graph[3]).toEqual({
      '@type': 'FAQPage',
      mainEntity: [
        {
          '@type': 'Question',
          name: 'What does it cost?',
          acceptedAnswer: { '@type': 'Answer', text: 'AtPrice charges 0% in this pilot.' },
        },
      ],
    });
  });
});

describe('serializeJsonLd', () => {
  it('escapes < so a value can never close the script tag', () => {
    const json = serializeJsonLd({ name: '</script><script>alert(1)</script>' });
    expect(json).not.toContain('<');
    expect(JSON.parse(json)).toEqual({ name: '</script><script>alert(1)</script>' });
  });
});

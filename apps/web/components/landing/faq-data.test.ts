import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Faq } from './closing';
import { FAQS, faqAnswerText, faqItems } from './faq-data';

/** Each answer paragraph's text as a reader sees it. */
const renderedAnswers = (): string[] =>
  [...renderToStaticMarkup(createElement(Faq)).matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((match) =>
    (match[1] ?? '')
      .replace(/<!-- -->/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&#x27;/g, "'")
      .replace(/&amp;/g, '&'),
  );

describe('landing FAQ structured data', () => {
  it('matches the visible questions and answers word for word', () => {
    // #given the FAQPage items and the rendered section
    const items = faqItems();

    // #then every answer is the same text, in the same order
    expect(items.map((item) => item.question)).toEqual(FAQS.map((entry) => entry.question));
    expect(items.map((item) => item.answer)).toEqual(renderedAnswers());
  });

  it('spells out the fee figures the page sets in tabular numerals', () => {
    const cost = FAQS[0];
    expect(cost?.question).toBe('What does it cost?');
    expect(faqAnswerText(cost?.answer ?? [])).toMatch(/^AtPrice charges 0% in this pilot, and the contract has no fee output/);
    expect(faqAnswerText(cost?.answer ?? [])).toMatch(/\d[\d,]* sat on AtPrice orders, and never more than \d[\d,]* sat for any order/);
  });
});

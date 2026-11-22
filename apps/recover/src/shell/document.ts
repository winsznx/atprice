import { binToHex, sha256, utf8ToBin } from '@bitauth/libauth';

/**
 * The parts of the Recover file that vary between builds. Everything else in the file is the fixed
 * template below, so the page can rebuild its own bytes from the DOM and show the file's SHA-256
 * (a file can't contain its own hash, but it can contain the function that recomputes it).
 */
export interface DocumentParts {
  readonly title: string;
  /** The Content-Security-Policy, also sent as a header by the `/recover` route. */
  readonly csp: string;
  /** `data:image/svg+xml;base64,…` favicon, so the browser makes no favicon request. */
  readonly icon: string;
  readonly css: string;
  readonly js: string;
}

/** The whole file. Byte for byte what the build writes and what `/recover` serves. */
export const renderRecoverDocument = (parts: DocumentParts): string =>
  '<!doctype html>\n' +
  '<html lang="en">\n' +
  '<head>\n' +
  '<meta charset="utf-8">\n' +
  `<meta http-equiv="Content-Security-Policy" content="${parts.csp}">\n` +
  '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
  '<meta name="color-scheme" content="light">\n' +
  '<meta name="referrer" content="no-referrer">\n' +
  `<title>${parts.title}</title>\n` +
  `<link rel="icon" href="${parts.icon}">\n` +
  `<style>${parts.css}</style>\n` +
  '</head>\n' +
  '<body>\n' +
  '<div id="root"></div>\n' +
  `<script type="module">${parts.js}</script>\n` +
  '</body>\n' +
  '</html>\n';

export const sha256Hex = (text: string): string => binToHex(sha256.hash(utf8ToBin(text)));

/** Characters the template can carry verbatim in an attribute or raw-text element without escaping. */
export const assertTemplateSafe = (parts: DocumentParts): void => {
  for (const [name, value] of [
    ['title', parts.title],
    ['csp', parts.csp],
    ['icon', parts.icon],
  ] as const) {
    if (/[<>&"]/.test(value))
      throw new Error(`RECOVER_TEMPLATE_UNSAFE: ${name} contains a character that needs escaping`);
  }
  if (/<\/style/i.test(parts.css))
    throw new Error('RECOVER_TEMPLATE_UNSAFE: the stylesheet contains </style');
  if (/<\/script|<!--/i.test(parts.js))
    throw new Error('RECOVER_TEMPLATE_UNSAFE: the script contains </script or <!--');
  if (/\r/.test(parts.css + parts.js))
    throw new Error('RECOVER_TEMPLATE_UNSAFE: carriage returns would be normalized');
};

/**
 * Reads the varying parts back from the live document. Raw-text elements (`style`, `script`) and
 * attributes without entities come back exactly as written, so rendering them again gives the file.
 */
export const readDocumentParts = (doc: Document): DocumentParts | null => {
  const csp = doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content');
  const icon = doc.querySelector('link[rel="icon"]')?.getAttribute('href');
  const css = doc.querySelector('head > style')?.textContent;
  const js = doc.querySelector('script[type="module"]')?.textContent;
  const title = doc.querySelector('head > title')?.textContent;
  if (csp == null || icon == null || css == null || js == null || title == null) return null;
  return { title, csp, icon, css, js };
};

/** The SHA-256 of the file this page was loaded from, recomputed in the browser. */
export const computeFileHash = (doc: Document): string | null => {
  const parts = readDocumentParts(doc);
  return parts === null ? null : sha256Hex(renderRecoverDocument(parts));
};

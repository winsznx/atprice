/**
 * Reads a colour from `app/tokens.css`. Generated images (Open Graph cards, app icons, the manifest)
 * can't use CSS variables, so they take the token's literal value from the one source of truth instead
 * of repeating it. A missing or non-hex token throws, which fails `next build`.
 */
export const colourToken = (css: string, name: string): string => {
  const match = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(css);
  if (match?.[1] === undefined) throw new Error(`app/tokens.css has no hex value for --color-${name}`);
  return match[1];
};

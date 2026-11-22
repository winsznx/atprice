import { describe, expect, it } from 'vitest';
import { cn } from './utils';

describe('cn', () => {
  it('keeps a text colour next to a DD 4 type-scale size', () => {
    expect(cn('text-brand-fg', 'text-label')).toBe('text-brand-fg text-label');
    expect(cn('text-body', 'text-label')).toBe('text-label');
    expect(cn('text-fg', 'text-fg-muted')).toBe('text-fg-muted');
  });
});

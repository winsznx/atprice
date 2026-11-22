'use client';

/**
 * Phosphor icons that a server component passes as a prop to a client component (`EmptyState`'s
 * `icon`). Phosphor's modules aren't client references, so a server component can't hand its own
 * import across the boundary: React can't serialize a component. These re-exports are client
 * references, so it can.
 */
export { ProhibitInsetIcon } from '@phosphor-icons/react';

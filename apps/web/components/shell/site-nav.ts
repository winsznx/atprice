/** Main navigation (PRD 6.1, DD 8). Wallet lives in the header button at lg+ and in the menu below lg. */
export interface NavItem {
  readonly href: string;
  readonly label: string;
  /** Shown inline in the desktop header; the rest only in the mobile menu. */
  readonly desktop: boolean;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/trade', label: 'Trade', desktop: true },
  { href: '/markets', label: 'Markets', desktop: true },
  { href: '/orders', label: 'My orders', desktop: true },
  { href: '/activity', label: 'Activity', desktop: true },
  { href: '/wallet', label: 'Wallet', desktop: false },
  { href: '/evidence', label: 'Evidence', desktop: true },
];

export const isActive = (pathname: string, href: string): boolean =>
  pathname === href || pathname.startsWith(`${href}/`);

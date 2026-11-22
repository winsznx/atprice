import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/app-shell';
import { SiteFooter } from '@/components/shell/site-footer';

export default function AppLayout({ children }: { readonly children: ReactNode }) {
  return <AppShell footer={<SiteFooter />}>{children}</AppShell>;
}

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

import { WalletChip } from '../wallet/wallet-chip';
import { ServiceBanner } from './service-banner';

const NAV = [
  { href: '/app', label: 'Overview', exact: true },
  { href: '/app/orders', label: 'Orders' },
  { href: '/app/funding', label: 'Funding' },
  { href: '/app/anchor', label: 'Local payments' },
  { href: '/app/activity', label: 'Activity' },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-3">
          <div className="flex items-center gap-8">
            <Link href="/app" className="text-lg font-semibold tracking-tight">
              Milvance
            </Link>
            <nav aria-label="Workspace" className="flex flex-wrap gap-1">
              {NAV.map((item) => {
                const active =
                  'exact' in item ? pathname === item.href : pathname?.startsWith(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'rounded-md px-3 py-1.5 text-sm',
                      active ? 'bg-background font-medium' : 'text-muted hover:text-foreground',
                    )}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </div>
          <WalletChip />
        </div>
      </header>
      <ServiceBanner />
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-6 py-8">
        {children}
      </main>
      <footer className="border-t border-border px-6 py-4 text-center text-xs text-muted">
        Stellar Testnet · Soroban holds the money and enforces the rules · this workspace only reads
        it and asks your wallet to sign
      </footer>
    </div>
  );
}

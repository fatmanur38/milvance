'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

import { WalletChip } from '../wallet/wallet-chip';
import { ServiceBanner } from './service-banner';

const NAV = [
  { href: '/demo', label: 'Guided tour', exact: true },
  { href: '/app', label: 'Overview', exact: true },
  { href: '/app/orders', label: 'Orders' },
  { href: '/app/funding', label: 'Funding' },
  { href: '/app/trade-lab', label: 'Trade Lab' },
  { href: '/app/anchor', label: 'Local payments' },
  { href: '/app/activity', label: 'Activity' },
  { href: '/app/metrics', label: 'Traction' },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="flex min-h-screen flex-col">
      {/*
        Sticky, because the wallet chip is the answer to "who am I signing as?"
        and that question comes up at the bottom of a long order page as often
        as at the top.
      */}
      <header className="sticky top-0 z-30 border-b border-border bg-surface/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-6 py-3">
          <div className="flex min-w-0 items-center gap-6">
            <Link
              href="/"
              className="text-lg font-semibold tracking-tight whitespace-nowrap"
              aria-label="Milvance home"
            >
              Milvance
            </Link>
            <nav aria-label="Workspace" className="flex flex-wrap items-center gap-0.5">
              {NAV.map((item) => {
                const active =
                  'exact' in item ? pathname === item.href : pathname?.startsWith(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'rounded-lg px-3 py-1.5 text-sm transition',
                      active
                        ? 'bg-background font-medium text-foreground shadow-card'
                        : 'text-muted hover:bg-background hover:text-foreground',
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
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-6 py-8 sm:py-10">
        {children}
      </main>
      <footer className="mt-4 border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-3 gap-y-1 px-6 py-5 text-center text-xs text-muted">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-capital" />
            Stellar Testnet
          </span>
          <span aria-hidden>·</span>
          <span>Soroban holds the money and enforces the rules</span>
          <span aria-hidden>·</span>
          <span>this workspace only reads it and asks your wallet to sign</span>
        </div>
      </footer>
    </div>
  );
}

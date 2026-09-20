import Link from 'next/link';

import { GuidedTour } from '@/components/demo/guided-tour';

export const metadata = {
  title: 'Milvance — guided tour',
  description: 'A real financed trade on Stellar Testnet, explained step by step.',
};

/**
 * The judge's entry point.
 *
 * Public, wallet-free and outside the workspace shell on purpose: someone
 * evaluating Milvance should be able to understand it before installing
 * anything. What they read is real chain history, narrated — not a demo mode
 * that pretends.
 */
export default function DemoPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-7xl min-w-0 flex-col gap-7 px-5 py-8 md:px-8 md:py-12">
      <header className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0 max-w-3xl">
          <p className="mb-3 inline-flex items-center gap-2 rounded-full border border-capital/30 bg-capital-soft px-3 py-1 text-xs font-semibold uppercase tracking-wider text-capital">
            <span className="h-2 w-2 rounded-full bg-capital" />
            <span className="sm:hidden">Testnet replay · no wallet</span>
            <span className="hidden sm:inline">Real Testnet replay · no wallet needed</span>
          </p>
          <h1 className="text-4xl font-semibold tracking-tight md:text-5xl">
            Watch the money move.
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted md:text-base">
            A buyer protects a payment. A funder sends separate working capital. After verification,
            Stellar repays the funder first. Explore a real trade, one on-chain event at a time.
          </p>
        </div>
        <Link
          href="/app/trade-lab"
          className="w-fit shrink-0 rounded-xl border border-border bg-surface px-4 py-2.5 text-sm font-semibold shadow-sm transition hover:border-protected lg:whitespace-nowrap"
        >
          Make your own trade ↗
        </Link>
      </header>

      <GuidedTour />
    </main>
  );
}

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
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-6 py-12">
      <header className="flex flex-col gap-2">
        <p className="text-sm text-muted">Guided tour · no wallet needed</p>
        <h1 className="text-3xl font-semibold tracking-tight">
          How a trade actually moves through Milvance
        </h1>
        <p className="text-sm text-muted">
          A buyer protects a milestone payment instead of prepaying. A funder advances working
          capital against it. Stellar repays the funder first when the work is verified. Below is
          one such trade, transaction by transaction.
        </p>
      </header>

      <GuidedTour />
    </main>
  );
}

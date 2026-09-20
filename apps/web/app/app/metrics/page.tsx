import { TractionView } from '@/components/metrics/traction-view';

/**
 * Public traction (AGENT.md §27, §29, PKG-11).
 *
 * Read-only and wallet-free: the numbers are the same for everyone, because
 * they are indexed chain state rather than anything about the viewer.
 */
export default function MetricsPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Traction</h1>
        <p className="text-sm text-muted">
          Every figure here is derived from MilvanceCore events on Stellar Testnet, or is an Anchor
          report labelled as one. Nothing on this page can be typed in.
        </p>
      </div>
      <TractionView />
    </div>
  );
}

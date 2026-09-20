'use client';

import { useReadiness } from '@/lib/api/queries';

/**
 * Tells people when the workspace itself is behind or down.
 *
 * The banner is about the READ MODEL, never about funds: Stellar holds the
 * money and the rules, so a stalled indexer means stale screens, not risk.
 */
export function ServiceBanner() {
  const readiness = useReadiness();

  if (readiness.isPending) return null;
  if (readiness.isError) {
    return (
      <div className="border-b border-danger/30 bg-danger-soft px-6 py-2 text-sm" role="alert">
        The workspace service is unreachable, so nothing below can be refreshed. Funds and contract
        state on Stellar are unaffected.
      </div>
    );
  }
  const { status, checks } = readiness.data;
  if (status === 'ok') return null;
  const detail =
    checks.indexer.status !== 'ok'
      ? 'Workspace data may be behind Stellar while the indexer catches up.'
      : checks.rpc.status !== 'ok'
        ? 'The Stellar network is not reachable from the workspace right now.'
        : 'Part of the workspace service is unavailable.';
  return (
    <div className="border-b border-attention/30 bg-attention-soft px-6 py-2 text-sm" role="status">
      {detail} Contract state on Stellar remains authoritative.
    </div>
  );
}

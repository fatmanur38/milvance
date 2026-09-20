'use client';

import { shortAddress } from '@/lib/domain/roles';
import { useWallet } from '@/lib/wallet/provider';

import { Button } from '../ui/primitives';

/** Compact wallet state for the shell header. */
export function WalletChip() {
  const { controller, state } = useWallet();

  if (state.phase === 'connecting') {
    return <span className="text-sm text-muted">Connecting…</span>;
  }
  if (!state.address) {
    return <Button onClick={() => void controller.connect()}>Connect wallet</Button>;
  }
  return (
    <div className="flex items-center gap-2 text-sm">
      {state.phase === 'wrong-network' ? (
        <span className="rounded-full bg-danger-soft px-2.5 py-1 text-xs font-medium text-danger">
          Wrong network
        </span>
      ) : (
        <span className="rounded-full bg-capital-soft px-2.5 py-1 text-xs font-medium text-capital">
          Testnet
        </span>
      )}
      <code title={state.address} className="font-mono text-xs">
        {shortAddress(state.address)}
      </code>
      <Button variant="ghost" onClick={() => void controller.disconnect()}>
        Disconnect
      </Button>
    </div>
  );
}

/**
 * Shown where a page needs to know who you are. Explains, never blocks
 * reading: chain-derived data is public, but actions need your wallet.
 */
export function WalletNotice() {
  const { controller, state } = useWallet();
  if (state.phase === 'wrong-network') {
    return (
      <div className="rounded-lg border border-danger/30 bg-danger-soft p-4 text-sm" role="alert">
        <p className="font-medium">Your wallet is on the wrong network</p>
        <p className="mt-1">
          Milvance runs on Stellar Testnet. Switch Freighter to Testnet, then{' '}
          <button type="button" className="underline" onClick={() => void controller.refresh()}>
            check again
          </button>
          . Nothing can be signed until it matches.
        </p>
      </div>
    );
  }
  if (!state.address) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface p-4 text-sm">
        <p>
          Connect your Stellar wallet to see the orders you are part of. You sign every action
          yourself — Milvance never holds your keys.
        </p>
        <Button onClick={() => void controller.connect()}>Connect wallet</Button>
      </div>
    );
  }
  if (state.trustline === 'unfunded') {
    return (
      <div
        className="rounded-lg border border-attention/30 bg-attention-soft p-4 text-sm"
        role="status"
      >
        This Testnet account is not funded yet. Fund it with Friendbot, then add the USDC trustline
        in Freighter.
      </div>
    );
  }
  if (state.trustline === 'missing') {
    return (
      <div
        className="rounded-lg border border-attention/30 bg-attention-soft p-4 text-sm"
        role="status"
      >
        No USDC trustline yet. You can still review and sign actions that do not move money; add the
        USDC trustline in Freighter before sending or receiving USDC.
      </div>
    );
  }
  return null;
}

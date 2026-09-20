'use client';

import type { ReactNode } from 'react';

import { isBusy } from '@/lib/tx/lifecycle';
import type { ContractTransaction } from '@/lib/tx/use-transaction';

import { TransactionStatus } from '../tx/transaction-status';

/**
 * Frame for one wallet-signed decision.
 *
 * `review` states exactly what will be signed, in product language, before
 * the wallet prompt appears. The wallet then shows the same action for the
 * person to approve.
 */
export function ActionPanel({
  title,
  who,
  children,
  review,
  tx,
}: {
  title: string;
  /** e.g. "You, as supplier" — reminds people which hat they are wearing. */
  who: string;
  children?: ReactNode;
  review?: ReactNode;
  tx: ContractTransaction;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-4" aria-label={title}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium">{title}</p>
        <span className="text-xs text-muted">{who}</span>
      </div>
      {children}
      {review && !isBusy(tx.state) && tx.state.stage !== 'synced' && (
        <div className="rounded-md bg-background p-3 text-xs text-muted">{review}</div>
      )}
      <TransactionStatus state={tx.state} onDismiss={tx.reset} />
    </div>
  );
}

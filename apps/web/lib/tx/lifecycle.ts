import type { TxFailure } from './errors';
import type { RunnerStage } from './runner';

/**
 * The visible life of one wallet-signed action.
 *
 *   idle → preparing → awaiting-signature → submitted → confirming
 *        → syncing ("Confirmed on Stellar. Updating workspace…")
 *        → synced | sync-delayed
 *   any step → failed
 *
 * `syncing` is the honest middle ground the product needs: the chain has
 * confirmed, but the read model may not have caught up. We never claim a final
 * financial state before Stellar confirms it, and we never report a confirmed
 * transaction as failed just because the workspace is a few ledgers behind.
 */
export type TxStage = 'idle' | RunnerStage | 'syncing' | 'synced' | 'sync-delayed' | 'failed';

export interface TxState {
  readonly stage: TxStage;
  readonly label?: string;
  readonly hash?: string;
  readonly ledger?: number;
  readonly failure?: TxFailure;
}

export type TxEvent =
  | { type: 'start'; label: string }
  | { type: 'stage'; stage: RunnerStage; hash?: string }
  | { type: 'confirmed'; hash: string; ledger: number }
  | { type: 'synced' }
  | { type: 'sync-delayed' }
  | { type: 'failed'; failure: TxFailure }
  | { type: 'reset' };

export const IDLE: TxState = { stage: 'idle' };

const TERMINAL: ReadonlySet<TxStage> = new Set(['idle', 'synced', 'sync-delayed', 'failed']);

export function isBusy(state: TxState): boolean {
  return !TERMINAL.has(state.stage);
}

export function txReducer(state: TxState, event: TxEvent): TxState {
  switch (event.type) {
    case 'start':
      return { stage: 'preparing', label: event.label };
    case 'stage':
      // Late progress callbacks must not resurrect a finished transaction.
      if (TERMINAL.has(state.stage) || state.stage === 'syncing') return state;
      return {
        ...state,
        stage: event.stage,
        ...(event.hash !== undefined ? { hash: event.hash } : {}),
      };
    case 'confirmed':
      return { ...state, stage: 'syncing', hash: event.hash, ledger: event.ledger };
    case 'synced':
      return state.stage === 'syncing' ? { ...state, stage: 'synced' } : state;
    case 'sync-delayed':
      return state.stage === 'syncing' ? { ...state, stage: 'sync-delayed' } : state;
    case 'failed':
      return { ...state, stage: 'failed', failure: event.failure };
    case 'reset':
      return IDLE;
  }
}

/** Product copy for each stage. */
export const STAGE_COPY: Record<TxStage, string> = {
  idle: '',
  preparing: 'Checking the action with Stellar…',
  'awaiting-signature': 'Approve the request in your wallet.',
  submitted: 'Submitted to Stellar.',
  confirming: 'Waiting for Stellar to confirm…',
  syncing: 'Confirmed on Stellar. Updating workspace…',
  synced: 'Confirmed on Stellar. Workspace updated.',
  'sync-delayed':
    'Confirmed on Stellar. The workspace has not caught up yet — it will show the change once the indexer does.',
  failed: '',
};

export interface IndexerProgress {
  readonly scannedThroughLedger: string | null;
}

/**
 * Wait until the indexer has scanned the ledger a transaction landed in.
 *
 * Polls rather than guessing a delay. API errors while polling are tolerated:
 * the transaction is already final on chain, so a flaky read is a reason to
 * keep waiting, not a reason to report failure.
 */
export async function waitForIndexer(
  ledger: number,
  readStatus: () => Promise<IndexerProgress>,
  options: {
    intervalMs?: number;
    timeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<'synced' | 'delayed'> {
  const interval = options.intervalMs ?? 2_000;
  const timeout = options.timeoutMs ?? 90_000;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const target = BigInt(ledger);
  const deadline = now() + timeout;

  for (;;) {
    try {
      const status = await readStatus();
      if (status.scannedThroughLedger !== null && BigInt(status.scannedThroughLedger) >= target) {
        return 'synced';
      }
    } catch {
      // Keep waiting; see above.
    }
    if (now() >= deadline) return 'delayed';
    await sleep(interval);
  }
}

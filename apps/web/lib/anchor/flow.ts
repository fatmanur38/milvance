import type {
  AnchorCapabilities,
  AnchorQuote,
  AnchorSession,
  AnchorTransaction,
} from '@milvance/anchor';
import { isQuoteExpired, isTerminal } from '@milvance/anchor';

import { anchorConfig } from './config';

/** Formats a local-currency amount for display. */
export function formatLocal(amount: string): string {
  const value = Number(amount);
  return Number.isFinite(value)
    ? `${value.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${anchorConfig.localCurrency}`
    : `${amount} ${anchorConfig.localCurrency}`;
}

export function formatUsdc(amount: string): string {
  const value = Number(amount);
  return Number.isFinite(value)
    ? `${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 7 })} USDC`
    : `${amount} USDC`;
}

/** Seconds left on a quote, floored at zero. */
export function quoteSecondsLeft(quote: AnchorQuote, nowSeconds: number): number {
  return Math.max(0, quote.expiresAt - nowSeconds);
}

/**
 * Guards a quote at the moment of use.
 *
 * A quote is a firm price with an expiry. Using an expired one would either be
 * rejected by the Anchor or silently repriced, so callers check here first and
 * ask for a fresh rate instead.
 */
export function assertQuoteUsable(quote: AnchorQuote, nowSeconds: number): void {
  if (isQuoteExpired(quote, nowSeconds)) {
    throw new Error('That exchange rate expired. Get a new rate before continuing.');
  }
}

/** Validates a deposit amount against the Anchor's published band. */
export function validateDepositAmount(amount: string): string | null {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return 'Enter an amount to deposit.';
  if (value < anchorConfig.depositMin) {
    return `This provider accepts at least ${anchorConfig.depositMin} ${anchorConfig.localCurrency} per transfer.`;
  }
  if (value > anchorConfig.depositMax) {
    return `This provider accepts at most ${anchorConfig.depositMax} ${anchorConfig.localCurrency} per transfer.`;
  }
  return null;
}

export function validateWithdrawAmount(amount: string): string | null {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return 'Enter an amount to convert.';
  if (value < anchorConfig.withdrawMin) {
    return `This provider converts at least ${anchorConfig.withdrawMin} USDC at a time.`;
  }
  return null;
}

/** Plain-language status, so the UI never implies a transfer is done early. */
export function describeStatus(transaction: AnchorTransaction): string {
  switch (transaction.status) {
    case 'pending_user_transfer_start':
      return transaction.kind === 'deposit'
        ? `Waiting for your ${anchorConfig.localCurrency} transfer to arrive.`
        : 'Waiting for your USDC payment.';
    case 'pending_user_transfer_complete':
      return 'Your transfer was sent and is being matched.';
    case 'pending_external':
      return 'The banking side is processing.';
    case 'pending_anchor':
      return 'The provider is processing the exchange.';
    case 'pending_stellar':
      return 'Settling on Stellar.';
    case 'pending_trust':
      return 'Waiting for a USDC trustline on the destination account.';
    case 'pending_user':
      return 'The provider needs something from you.';
    case 'completed':
      return transaction.kind === 'deposit'
        ? 'Done. USDC is in your wallet.'
        : `Done. ${anchorConfig.localCurrency} was paid out.`;
    case 'refunded':
      return 'The provider refunded this transfer.';
    case 'expired':
      return 'This transfer expired before it completed.';
    case 'too_small':
      return 'The amount was below the provider’s minimum.';
    case 'too_large':
      return 'The amount was above the provider’s maximum.';
    case 'no_market':
      return 'The provider could not price this pair.';
    case 'error':
      return transaction.message ?? 'The provider reported an error.';
    default:
      return 'Starting.';
  }
}

/** Only a completed transfer is presented as finished. */
export function isFinished(transaction: AnchorTransaction): boolean {
  return isTerminal(transaction.status);
}

export interface PollOptions {
  readonly intervalMs?: number;
  readonly maxAttempts?: number;
  readonly onUpdate?: (transaction: AnchorTransaction) => void;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Polls a transfer until it reaches a terminal status or attempts run out. */
export async function pollTransfer(
  read: (
    id: string,
    session: AnchorSession,
    capabilities: AnchorCapabilities,
  ) => Promise<AnchorTransaction>,
  id: string,
  session: AnchorSession,
  capabilities: AnchorCapabilities,
  options: PollOptions = {},
): Promise<AnchorTransaction> {
  const interval = options.intervalMs ?? 2_000;
  const maxAttempts = options.maxAttempts ?? 45;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  let latest = await read(id, session, capabilities);
  options.onUpdate?.(latest);

  for (let attempt = 1; attempt < maxAttempts && !isTerminal(latest.status); attempt += 1) {
    await sleep(interval);
    latest = await read(id, session, capabilities);
    options.onUpdate?.(latest);
  }

  return latest;
}

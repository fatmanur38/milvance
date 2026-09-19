/**
 * Anchor domain types (PKG-07).
 *
 * These describe the SEP surface in product terms, so the rest of Milvance can
 * talk about "local money in, local money out" without importing SEP numbers.
 */

/** A SEP-38 asset identifier: `stellar:CODE:ISSUER` or `iso4217:TRY`. */
export type AssetId = string;

export function stellarAsset(code: string, issuer: string): AssetId {
  return `stellar:${code}:${issuer}`;
}

export function fiatAsset(currency: string): AssetId {
  return `iso4217:${currency}`;
}

export interface AnchorCurrency {
  readonly code: string;
  readonly issuer: string;
  /** The off-chain asset this token is anchored to, e.g. `TRY`. */
  readonly anchorAsset?: string;
}

/**
 * Everything discovered from the Anchor's SEP-1 `stellar.toml`.
 *
 * Endpoints are discovered, never hard-coded, so pointing Milvance at a
 * production Anchor is a home-domain change and nothing more.
 */
export interface AnchorCapabilities {
  readonly homeDomain: string;
  readonly networkPassphrase: string;
  /** The Anchor's SEP-10 server signing key. */
  readonly signingKey: string;
  readonly webAuthEndpoint: string;
  readonly transferServer: string;
  readonly kycServer: string;
  readonly quoteServer: string;
  readonly currencies: readonly AnchorCurrency[];
}

// ---------------------------------------------------------------------------
// SEP-10 — wallet authentication
// ---------------------------------------------------------------------------

export interface BeginAuthInput {
  readonly capabilities: AnchorCapabilities;
  /** The user's own Stellar account. */
  readonly account: string;
  readonly memo?: string;
}

export interface AuthChallenge {
  /** Unsigned challenge transaction. The **user's wallet** signs this. */
  readonly transactionXdr: string;
  readonly networkPassphrase: string;
}

export interface SignedChallengeInput {
  readonly capabilities: AnchorCapabilities;
  /** The challenge after the user's wallet signed it. */
  readonly signedTransactionXdr: string;
}

/**
 * An authenticated Anchor session.
 *
 * `token` is a SEP-10 JWT. It is the user's bearer credential: never log it,
 * never persist it, never put it in an error message or a URL.
 */
export interface AnchorSession {
  readonly token: string;
  readonly account: string;
  /** Unix seconds. */
  readonly expiresAt: number;
}

// ---------------------------------------------------------------------------
// SEP-12 — customer status
// ---------------------------------------------------------------------------

export type CustomerStatusValue = 'NEEDS_INFO' | 'PROCESSING' | 'ACCEPTED' | 'REJECTED';

export interface CustomerStatus {
  readonly status: CustomerStatusValue;
  readonly id?: string;
  /** Field names the Anchor still wants, if any. */
  readonly missingFields: readonly string[];
}

// ---------------------------------------------------------------------------
// SEP-38 — quotes
// ---------------------------------------------------------------------------

export interface QuoteInput {
  readonly capabilities: AnchorCapabilities;
  readonly session: AnchorSession;
  readonly sellAsset: AssetId;
  readonly buyAsset: AssetId;
  /** Exactly one of sellAmount / buyAmount. */
  readonly sellAmount?: string;
  readonly buyAmount?: string;
  /** SEP-38 context: `sep6` for ramp quotes. */
  readonly context?: 'sep6' | 'sep31';
  readonly sellDeliveryMethod?: string;
  readonly buyDeliveryMethod?: string;
}

export interface QuoteFeeDetail {
  readonly name: string;
  readonly amount: string;
  readonly description?: string;
}

export interface AnchorQuote {
  readonly id: string;
  readonly sellAsset: AssetId;
  readonly sellAmount: string;
  readonly buyAsset: AssetId;
  readonly buyAmount: string;
  /** Rate excluding fees. */
  readonly price: string;
  /** Rate including fees — what the user actually gets. */
  readonly totalPrice: string;
  /** Unix seconds. */
  readonly expiresAt: number;
  readonly feeTotal?: string;
  readonly feeAsset?: AssetId;
  readonly feeDetails: readonly QuoteFeeDetail[];
}

/** Whether a firm quote may still be used. */
export function isQuoteExpired(quote: AnchorQuote, nowSeconds: number): boolean {
  return nowSeconds >= quote.expiresAt;
}

// ---------------------------------------------------------------------------
// SEP-6 — deposit and withdraw
// ---------------------------------------------------------------------------

export type AnchorTransactionKind = 'deposit' | 'withdrawal';

/**
 * SEP-6 transaction statuses.
 *
 * Only `completed` means value has arrived. Everything else is in flight, and
 * the UI must never present it as done.
 */
export type AnchorTransactionStatus =
  | 'incomplete'
  | 'pending_user_transfer_start'
  | 'pending_user_transfer_complete'
  | 'pending_external'
  | 'pending_anchor'
  | 'pending_stellar'
  | 'pending_trust'
  | 'pending_user'
  | 'completed'
  | 'refunded'
  | 'expired'
  | 'no_market'
  | 'too_small'
  | 'too_large'
  | 'error';

/** Terminal statuses that will never progress on their own. */
const TERMINAL: readonly AnchorTransactionStatus[] = [
  'completed',
  'refunded',
  'expired',
  'no_market',
  'too_small',
  'too_large',
  'error',
];

export function isTerminal(status: AnchorTransactionStatus): boolean {
  return TERMINAL.includes(status);
}

export function isSettled(status: AnchorTransactionStatus): boolean {
  return status === 'completed';
}

/** A single SEP-9 bank instruction field the Anchor returned. */
export interface AnchorInstruction {
  readonly value: string;
  readonly description?: string;
}

export interface DepositInput {
  readonly capabilities: AnchorCapabilities;
  readonly session: AnchorSession;
  /** On-chain asset code, e.g. `USDC`. */
  readonly assetCode: string;
  /** Where the USDC should land: the user's own Stellar account. */
  readonly destinationAccount: string;
  readonly amount?: string;
  /** Firm SEP-38 quote to lock the rate. */
  readonly quoteId?: string;
  /**
   * Off-chain asset being sold, in SEP-38 form (`iso4217:TRY`). Supplying it
   * selects the `deposit-exchange` endpoint, which is what honours a quote.
   */
  readonly sourceAsset?: AssetId;
  readonly fundingMethod?: string;
}

export interface WithdrawInput {
  readonly capabilities: AnchorCapabilities;
  readonly session: AnchorSession;
  readonly assetCode: string;
  /** The account the USDC will be sent from. */
  readonly sourceAccount: string;
  readonly amount?: string;
  readonly quoteId?: string;
  /**
   * Off-chain asset being bought, in SEP-38 form (`iso4217:TRY`). Supplying it
   * selects the `withdraw-exchange` endpoint.
   */
  readonly destinationAsset?: AssetId;
  readonly fundingMethod?: string;
}

export interface AnchorTransaction {
  readonly id: string;
  readonly kind: AnchorTransactionKind;
  readonly status: AnchorTransactionStatus;
  readonly amountIn?: string;
  readonly amountOut?: string;
  readonly amountFee?: string;
  readonly quoteId?: string;

  /** Deposit: SEP-9 bank instructions for the incoming TRY transfer. */
  readonly instructions: Readonly<Record<string, AnchorInstruction>>;

  /**
   * Withdrawal: the Anchor account the user must pay, and the memo that
   * identifies the payment. Sending without the memo strands the funds.
   */
  readonly withdrawAnchorAccount?: string;
  readonly withdrawMemo?: string;
  readonly withdrawMemoType?: 'text' | 'id' | 'hash';

  readonly stellarTransactionId?: string;
  readonly externalTransactionId?: string;
  readonly message?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

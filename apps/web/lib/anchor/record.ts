import type { AnchorTransaction } from '@milvance/anchor';

/**
 * Recording a completed local-payment leg.
 *
 * PKG-07 owns the Anchor protocol and keeps owning it: the browser holds its
 * own SEP-10 session and signs its own payments. This module does one narrow
 * thing afterwards — turn a finished transfer into the small, public-safe
 * record that lets traction metrics connect local money to chain money.
 *
 * What is built here is an allowlist, not a filter. The body is constructed
 * field by field from known-safe values, so a SEP-10 token, a KYC field or a
 * bank instruction cannot be carried along by accident: there is no code path
 * that copies the transfer wholesale.
 *
 * The Stellar hash recorded here is a claim, not proof. The API checks it
 * against Horizon before it may support any completed-cycle metric, and a wrong
 * hash fails that check — which is exactly what happened to the first leg ever
 * recorded by hand.
 */

export type LegDirection = 'TRY_TO_USDC' | 'USDC_TO_TRY';

export interface LocalPaymentLeg {
  readonly direction: LegDirection;
  readonly walletAddress: string;
  /** SEP-6 transfer id. The idempotency key: re-posting updates one row. */
  readonly anchorTransactionId: string;
  readonly stellarTxHash: string;
  /** What the wallet's owner sent, at the precision it was sent. */
  readonly sourceAmount: string;
  /** What they received, as the Anchor reported it. */
  readonly destinationAmount: string;
  readonly status: string;
  readonly quoteId?: string;
}

/** Fields that must never leave the browser, checked as a last line of defence. */
const FORBIDDEN = [
  'jwt',
  'token',
  'authorization',
  'bearer',
  'secret',
  'seed',
  'privatekey',
  'private_key',
  'secretkey',
  'kyc',
  'bankaccount',
  'bank_account',
  'iban',
  'nationalid',
  'national_id',
  'email',
  'phone',
];

const HASH = /^[0-9a-f]{64}$/i;
const DECIMAL = /^\d{1,32}(\.\d{1,7})?$/;
const ADDRESS = /^G[A-Z2-7]{55}$/;

export type LegResult =
  | { readonly ok: true; readonly leg: LocalPaymentLeg }
  | { readonly ok: false; readonly reason: string };

/**
 * Builds the record for a finished transfer, or explains why it cannot.
 *
 * Refusing is the normal outcome for a transfer that has not completed or has
 * no confirmed Stellar leg. A leg that cannot be described exactly is better
 * left unrecorded than recorded approximately: an approximate record is what
 * produces a traction number nobody can defend.
 */
export function buildLocalPaymentLeg(input: {
  readonly transfer: AnchorTransaction;
  readonly direction: 'deposit' | 'withdraw';
  readonly walletAddress: string;
  /** For a withdrawal, the hash of the payment this browser submitted. */
  readonly submittedPaymentHash?: string | null;
  /** For a withdrawal, the exact USDC amount that payment carried. */
  readonly sentAmount?: string | null;
}): LegResult {
  const { transfer, direction, walletAddress } = input;

  if (!ADDRESS.test(walletAddress)) {
    return { ok: false, reason: 'No connected wallet to attribute this transfer to.' };
  }
  if (transfer.status !== 'completed') {
    return { ok: false, reason: 'The transfer has not completed yet.' };
  }

  // On a withdrawal the authoritative hash is the payment THIS browser signed
  // and submitted; on a deposit it is the Anchor's payout, which only the
  // Anchor can tell us. Horizon settles the difference either way.
  const hash =
    direction === 'withdraw'
      ? (input.submittedPaymentHash ?? transfer.stellarTransactionId ?? null)
      : (transfer.stellarTransactionId ?? null);
  if (hash === null || !HASH.test(hash)) {
    return { ok: false, reason: 'No Stellar transaction hash is known for this transfer.' };
  }

  // A withdrawal's USDC leg is the amount we actually sent, which we know
  // exactly. A deposit's is whatever the Anchor delivered, which we do not.
  const source =
    direction === 'withdraw' ? (input.sentAmount ?? transfer.amountIn) : transfer.amountIn;
  const destination = transfer.amountOut;
  if (source === undefined || source === null || !DECIMAL.test(source)) {
    return { ok: false, reason: 'The transfer has no exact amount to record.' };
  }
  if (destination === undefined || !DECIMAL.test(destination)) {
    return { ok: false, reason: 'The transfer has no exact received amount to record.' };
  }
  if (!/^[a-zA-Z0-9._:-]{1,120}$/.test(transfer.id)) {
    return { ok: false, reason: 'The transfer has no usable reference.' };
  }

  const leg: LocalPaymentLeg = {
    direction: direction === 'deposit' ? 'TRY_TO_USDC' : 'USDC_TO_TRY',
    walletAddress,
    anchorTransactionId: transfer.id,
    stellarTxHash: hash.toLowerCase(),
    sourceAmount: source,
    destinationAmount: destination,
    status: transfer.status,
    ...(transfer.quoteId !== undefined && /^[a-zA-Z0-9._:-]{1,120}$/.test(transfer.quoteId)
      ? { quoteId: transfer.quoteId }
      : {}),
  };

  const problem = unsafeField({ ...leg });
  if (problem !== null) {
    return { ok: false, reason: `Refusing to record a field named "${problem}".` };
  }
  return { ok: true, leg };
}

/**
 * Whether any key or value in the record looks like a credential.
 *
 * The body is built from an allowlist above, so this should never fire. It
 * exists because "should never" is not a guarantee, and a leaked SEP-10 token
 * would be a far worse bug than a missing traction row.
 */
export function unsafeField(leg: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(leg)) {
    const lowered = key.toLowerCase();
    for (const word of FORBIDDEN) {
      if (lowered.includes(word)) return key;
    }
    if (typeof value === 'string' && /\beyJ[A-Za-z0-9_-]{6,}\./.test(value)) return key;
    if (typeof value === 'string' && /\bS[A-Z2-7]{55}\b/.test(value)) return key;
  }
  return null;
}

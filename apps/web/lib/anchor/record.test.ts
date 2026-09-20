import { describe, expect, it } from 'vitest';

import type { AnchorTransaction } from '@milvance/anchor';

import { buildLocalPaymentLeg, unsafeField } from './record';

/**
 * Turning a finished Anchor transfer into a public-safe record.
 *
 * The record is a claim about Stellar that the API re-checks against Horizon,
 * so the job here is narrow: describe the leg exactly, or refuse. Approximate
 * records are what produce traction numbers nobody can defend.
 */
const WALLET = 'GBBS3FS2CXYQRUHDCGGAYTQCJ6BELVSWZSKXOGMSNWWBYMZ2RGZDYHXQ';
const HASH = 'a'.repeat(64);

function transfer(overrides: Partial<AnchorTransaction> = {}): AnchorTransaction {
  return {
    id: 'sep_n4kl7lygqpyd03fy2mjx',
    kind: 'withdrawal',
    status: 'completed',
    amountIn: '5.0000000',
    amountOut: '245.5000000',
    instructions: {},
    ...overrides,
  } as AnchorTransaction;
}

describe('recording a completed leg', () => {
  it('records an off-ramp with the hash this browser actually submitted', () => {
    const result = buildLocalPaymentLeg({
      transfer: transfer(),
      direction: 'withdraw',
      walletAddress: WALLET,
      submittedPaymentHash: HASH,
      sentAmount: '5.0000000',
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.leg).toEqual({
      direction: 'USDC_TO_TRY',
      walletAddress: WALLET,
      anchorTransactionId: 'sep_n4kl7lygqpyd03fy2mjx',
      stellarTxHash: HASH,
      sourceAmount: '5.0000000',
      destinationAmount: '245.5000000',
      status: 'completed',
    });
  });

  it('prefers the submitted hash over whatever the provider reports', () => {
    // The provider once reported a hash belonging to a different wallet's
    // payout. Our own submission is the stronger evidence.
    const result = buildLocalPaymentLeg({
      transfer: transfer({ stellarTransactionId: 'b'.repeat(64) }),
      direction: 'withdraw',
      walletAddress: WALLET,
      submittedPaymentHash: HASH,
      sentAmount: '5.0000000',
    });
    expect(result.ok && result.leg.stellarTxHash).toBe(HASH);
  });

  it('records an on-ramp from the provider’s payout hash', () => {
    const result = buildLocalPaymentLeg({
      transfer: transfer({
        kind: 'deposit',
        amountIn: '1000.0000000',
        amountOut: '20.3960908',
        stellarTransactionId: HASH.toUpperCase(),
      }),
      direction: 'deposit',
      walletAddress: WALLET,
    });
    expect(result.ok && result.leg.direction).toBe('TRY_TO_USDC');
    // Normalised, because Horizon and the database both speak lower case.
    expect(result.ok && result.leg.stellarTxHash).toBe(HASH);
    expect(result.ok && result.leg.destinationAmount).toBe('20.3960908');
  });

  it('keeps the exact amount rather than rounding it for display', () => {
    const result = buildLocalPaymentLeg({
      transfer: transfer({ amountOut: '245.1234567' }),
      direction: 'withdraw',
      walletAddress: WALLET,
      submittedPaymentHash: HASH,
      sentAmount: '0.0000001',
    });
    expect(result.ok && result.leg.sourceAmount).toBe('0.0000001');
    expect(result.ok && result.leg.destinationAmount).toBe('245.1234567');
  });

  it('carries the quote reference, which is not a credential', () => {
    const result = buildLocalPaymentLeg({
      transfer: transfer({ quoteId: 'quote_123' }),
      direction: 'withdraw',
      walletAddress: WALLET,
      submittedPaymentHash: HASH,
      sentAmount: '5.0000000',
    });
    expect(result.ok && result.leg.quoteId).toBe('quote_123');
  });
});

describe('refusing to record', () => {
  it('refuses a transfer that has not completed', () => {
    const result = buildLocalPaymentLeg({
      transfer: transfer({ status: 'pending_anchor' }),
      direction: 'withdraw',
      walletAddress: WALLET,
      submittedPaymentHash: HASH,
      sentAmount: '5.0000000',
    });
    expect(result).toEqual({ ok: false, reason: 'The transfer has not completed yet.' });
  });

  it('refuses when no Stellar hash is known', () => {
    const result = buildLocalPaymentLeg({
      transfer: transfer(),
      direction: 'deposit',
      walletAddress: WALLET,
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/no Stellar transaction hash/i);
  });

  it('refuses a malformed hash rather than recording it', () => {
    const result = buildLocalPaymentLeg({
      transfer: transfer(),
      direction: 'withdraw',
      walletAddress: WALLET,
      submittedPaymentHash: 'not-a-hash',
      sentAmount: '5.0000000',
    });
    expect(result.ok).toBe(false);
  });

  it('refuses without a connected wallet to attribute it to', () => {
    const result = buildLocalPaymentLeg({
      transfer: transfer(),
      direction: 'withdraw',
      walletAddress: 'nope',
      submittedPaymentHash: HASH,
      sentAmount: '5.0000000',
    });
    expect(result.ok).toBe(false);
  });

  it('refuses an amount that is not an exact decimal', () => {
    for (const bad of ['1e5', 'NaN', '1.123456789', '']) {
      const result = buildLocalPaymentLeg({
        transfer: transfer(),
        direction: 'withdraw',
        walletAddress: WALLET,
        submittedPaymentHash: HASH,
        sentAmount: bad,
      });
      expect(result.ok, bad).toBe(false);
    }
  });
});

describe('nothing sensitive can be carried along', () => {
  it('builds only the known fields, dropping everything else on the transfer', () => {
    const result = buildLocalPaymentLeg({
      transfer: transfer({
        // Shapes a SEP flow might carry. None may survive into the record.
        ...({
          jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.x',
          kyc: { nationalId: '123' },
          instructions: { bank_number: { value: 'TR12 0006 1005 1978 6457 8413 26' } },
        } as object),
      }),
      direction: 'withdraw',
      walletAddress: WALLET,
      submittedPaymentHash: HASH,
      sentAmount: '5.0000000',
    });
    expect(result.ok).toBe(true);
    const serialised = JSON.stringify(result.ok && result.leg);
    for (const forbidden of ['jwt', 'eyJ', 'kyc', 'nationalId', 'bank_number', 'TR12']) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it('catches a credential-shaped field if one ever appears', () => {
    expect(unsafeField({ jwt: 'x' })).toBe('jwt');
    expect(unsafeField({ note: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.x' })).toBe('note');
    expect(unsafeField({ note: `S${'A'.repeat(55)}` })).toBe('note');
    expect(unsafeField({ stellarTxHash: 'a'.repeat(64) })).toBeNull();
  });
});

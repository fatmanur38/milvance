import { describe, expect, it } from 'vitest';

import { ADDRESSES } from '../indexer/fixtures.test-helper';
import { verifyStellarLeg, type ReportedLeg } from './local-payment-cycles';

/**
 * Whether Stellar agrees with a reported local-payment leg.
 *
 * This is the gate the north-star metric stands on, so it is tested against
 * every way a report can be wrong — including the one that actually happened on
 * our own Testnet data, where a reported hash paid a different wallet the same
 * amount.
 */
const STELLAR = {
  horizonUrl: 'https://horizon-testnet.stellar.org',
  usdcIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
};

const HASH = 'f'.repeat(64);

const onRamp: ReportedLeg = {
  direction: 'TRY_TO_USDC',
  walletAddress: ADDRESSES.buyer,
  stellarTxHash: HASH,
  destinationAmount: '20.3960908',
  sourceAmount: '1000.0000000',
};

function horizon(
  operations: readonly Record<string, unknown>[],
  transaction: Record<string, unknown> = { successful: true, created_at: '2026-09-19T17:52:27Z' },
) {
  return async (url: string): Promise<unknown> => {
    if (url.endsWith('/operations?limit=200')) return { _embedded: { records: operations } };
    return transaction;
  };
}

const payment = (overrides: Record<string, unknown> = {}) => ({
  type: 'payment',
  asset_code: 'USDC',
  asset_issuer: STELLAR.usdcIssuer,
  from: 'GCLCZEQZ2THTEDAOFI66LACNPLY4OBKN7VKLEZFMBIHYKYQOW2W7T3Z6',
  to: ADDRESSES.buyer,
  amount: '20.3960908',
  ...overrides,
});

describe('confirming a local-payment leg against Stellar', () => {
  it('confirms a payment that matches the report exactly', async () => {
    const verdict = await verifyStellarLeg(onRamp, STELLAR, horizon([payment()]));
    expect(verdict.status).toBe('CONFIRMED');
    expect(verdict.at?.toISOString()).toBe('2026-09-19T17:52:27.000Z');
  });

  it('confirms an off-ramp only when the wallet is the SENDER', async () => {
    const offRamp: ReportedLeg = {
      direction: 'USDC_TO_TRY',
      walletAddress: ADDRESSES.supplier,
      stellarTxHash: HASH,
      sourceAmount: '5.0000000',
      destinationAmount: '245.0000000',
    };
    const sent = payment({ from: ADDRESSES.supplier, to: 'GANCHOR', amount: '5.0000000' });
    expect((await verifyStellarLeg(offRamp, STELLAR, horizon([sent]))).status).toBe('CONFIRMED');

    // The same payment in the other direction is not an off-ramp.
    const received = payment({ from: 'GANCHOR', to: ADDRESSES.supplier, amount: '5.0000000' });
    expect((await verifyStellarLeg(offRamp, STELLAR, horizon([received]))).status).toBe(
      'MISMATCHED',
    );
  });

  it('rejects a payment to a different wallet, even for the identical amount', async () => {
    // This is the real failure found in live data: a mock Anchor pays every
    // 1000 TRY conversion the same USDC amount, so amount alone proves nothing.
    const other = payment({ to: 'GCGYLXQJX623CTS3ABRWUE7WOK4NNNNYAALUMC6KYJSQSUKTQHD6U2LL' });
    const verdict = await verifyStellarLeg(onRamp, STELLAR, horizon([other]));
    expect(verdict.status).toBe('MISMATCHED');
    expect(verdict.detail).toMatch(/different wallet/i);
  });

  it('rejects a different amount to the right wallet', async () => {
    const verdict = await verifyStellarLeg(
      onRamp,
      STELLAR,
      horizon([payment({ amount: '19.0000000' })]),
    );
    expect(verdict.status).toBe('MISMATCHED');
    expect(verdict.detail).toMatch(/different USDC amount/i);
  });

  it('rejects another issuer’s USDC', async () => {
    const fake = payment({
      asset_issuer: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    });
    expect((await verifyStellarLeg(onRamp, STELLAR, horizon([fake]))).status).toBe('MISMATCHED');
  });

  it('rejects a failed transaction', async () => {
    const verdict = await verifyStellarLeg(
      onRamp,
      STELLAR,
      horizon([payment()], { successful: false }),
    );
    expect(verdict.status).toBe('MISMATCHED');
  });

  it('is unverifiable without a hash, or when Stellar has never heard of it', async () => {
    expect(
      (await verifyStellarLeg({ ...onRamp, stellarTxHash: null }, STELLAR, horizon([]))).status,
    ).toBe('UNVERIFIABLE');
    expect(
      (await verifyStellarLeg({ ...onRamp, stellarTxHash: 'not-a-hash' }, STELLAR, horizon([])))
        .status,
    ).toBe('UNVERIFIABLE');
    const missing = async (): Promise<unknown> => {
      throw new Error('horizon responded 404');
    };
    expect((await verifyStellarLeg(onRamp, STELLAR, missing)).status).toBe('UNVERIFIABLE');
  });

  it('is unverifiable when the report records no USDC amount to match', async () => {
    const vague = { ...onRamp, destinationAmount: null };
    expect((await verifyStellarLeg(vague, STELLAR, horizon([payment()]))).status).toBe(
      'UNVERIFIABLE',
    );
  });

  it('never reports a credential or a bank detail in its explanation', async () => {
    for (const leg of [onRamp, { ...onRamp, stellarTxHash: null }]) {
      const verdict = await verifyStellarLeg(leg, STELLAR, horizon([payment({ amount: '1.0' })]));
      expect(verdict.detail).not.toMatch(/jwt|token|iban|secret|seed|password/i);
    }
  });
});

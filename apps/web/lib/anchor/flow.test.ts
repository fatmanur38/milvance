import { describe, expect, it, vi } from 'vitest';

import type { AnchorQuote, AnchorTransaction } from '@milvance/anchor';

import {
  assertQuoteUsable,
  describeStatus,
  isFinished,
  pollTransfer,
  quoteSecondsLeft,
  validateDepositAmount,
  validateWithdrawAmount,
} from './flow';

const quote = (expiresAt: number): AnchorQuote => ({
  id: 'q',
  sellAsset: 'iso4217:TRY',
  sellAmount: '1000',
  buyAsset: 'stellar:USDC:G',
  buyAmount: '20',
  price: '49',
  totalPrice: '49',
  expiresAt,
  feeDetails: [],
});

const transfer = (overrides: Partial<AnchorTransaction> = {}): AnchorTransaction => ({
  id: 'sep_1',
  kind: 'deposit',
  status: 'pending_anchor',
  instructions: {},
  ...overrides,
});

describe('quote expiry', () => {
  it('counts down and floors at zero', () => {
    expect(quoteSecondsLeft(quote(1_100), 1_000)).toBe(100);
    expect(quoteSecondsLeft(quote(1_000), 1_000)).toBe(0);
    expect(quoteSecondsLeft(quote(900), 1_000)).toBe(0);
  });

  it('blocks using an expired rate', () => {
    expect(() => assertQuoteUsable(quote(1_001), 1_000)).not.toThrow();
    expect(() => assertQuoteUsable(quote(1_000), 1_000)).toThrow(/expired/i);
  });
});

describe('amount limits', () => {
  it('enforces the provider’s TRY deposit band', () => {
    expect(validateDepositAmount('1000')).toBeNull();
    expect(validateDepositAmount('50')).toBeNull();
    expect(validateDepositAmount('3000')).toBeNull();
    expect(validateDepositAmount('49')).toMatch(/at least 50/);
    expect(validateDepositAmount('3001')).toMatch(/at most 3000/);
    expect(validateDepositAmount('0')).toMatch(/Enter an amount/);
    expect(validateDepositAmount('abc')).toMatch(/Enter an amount/);
  });

  it('enforces the provider’s USDC withdrawal floor', () => {
    expect(validateWithdrawAmount('1')).toBeNull();
    expect(validateWithdrawAmount('0.5')).toMatch(/at least 1 USDC/);
    expect(validateWithdrawAmount('-2')).toMatch(/Enter an amount/);
  });
});

describe('status presentation', () => {
  it('never describes an in-flight transfer as done', () => {
    for (const status of [
      'pending_user_transfer_start',
      'pending_anchor',
      'pending_stellar',
      'pending_external',
    ] as const) {
      const text = describeStatus(transfer({ status }));
      expect(text.toLowerCase()).not.toContain('done');
      expect(isFinished(transfer({ status }))).toBe(false);
    }
  });

  it('describes completion per direction', () => {
    expect(describeStatus(transfer({ status: 'completed' }))).toMatch(/USDC is in your wallet/);
    expect(describeStatus(transfer({ status: 'completed', kind: 'withdrawal' }))).toMatch(/TRY/);
  });

  it('surfaces an anchor error message and treats it as finished', () => {
    const failed = transfer({ status: 'error', message: 'bank rejected' });
    expect(describeStatus(failed)).toBe('bank rejected');
    expect(isFinished(failed)).toBe(true);
  });

  it('reports a missing trustline as its own waiting state', () => {
    expect(describeStatus(transfer({ status: 'pending_trust' }))).toMatch(/trustline/i);
  });
});

describe('polling', () => {
  it('stops as soon as the transfer reaches a terminal status', async () => {
    const statuses = ['pending_anchor', 'pending_stellar', 'completed', 'completed'] as const;
    let call = 0;
    const read = vi.fn(async () => transfer({ status: statuses[call++] ?? 'completed' }));

    const result = await pollTransfer(read, 'sep_1', {} as never, {} as never, {
      sleep: async () => undefined,
    });

    expect(result.status).toBe('completed');
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('gives up after the attempt budget rather than looping forever', async () => {
    const read = vi.fn(async () => transfer({ status: 'pending_anchor' }));

    const result = await pollTransfer(read, 'sep_1', {} as never, {} as never, {
      maxAttempts: 4,
      sleep: async () => undefined,
    });

    expect(result.status).toBe('pending_anchor');
    expect(isFinished(result)).toBe(false);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it('reports every intermediate status to the caller', async () => {
    const statuses = ['pending_anchor', 'completed'] as const;
    let call = 0;
    const read = vi.fn(async () => transfer({ status: statuses[call++] ?? 'completed' }));
    const seen: string[] = [];

    await pollTransfer(read, 'sep_1', {} as never, {} as never, {
      sleep: async () => undefined,
      onUpdate: (tx) => seen.push(tx.status),
    });

    expect(seen).toEqual(['pending_anchor', 'completed']);
  });
});

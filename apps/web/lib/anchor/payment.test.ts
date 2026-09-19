import { describe, expect, it } from 'vitest';

import type { AnchorTransaction } from '@milvance/anchor';

import { planWithdrawalPayment } from './payment';

type OptionalField = 'withdrawAnchorAccount' | 'withdrawMemo' | 'withdrawMemoType';

/**
 * Builds a withdrawal, optionally omitting fields.
 *
 * Fields are omitted rather than set to `undefined`, which is how a real anchor
 * response arrives when it leaves something out.
 */
function withdrawal(
  omit: readonly OptionalField[] = [],
  overrides: Partial<AnchorTransaction> = {},
): AnchorTransaction {
  const base: Record<string, unknown> = {
    id: 'sep_wd',
    kind: 'withdrawal',
    status: 'pending_user_transfer_start',
    instructions: {},
    withdrawAnchorAccount: 'GCLCZEQZ2THTEDAOFI66LACNPLY4OBKN7VKLEZFMBIHYKYQOW2W7T3Z6',
    withdrawMemo: '702799274298',
    withdrawMemoType: 'id',
    ...overrides,
  };
  for (const field of omit) delete base[field];
  return base as unknown as AnchorTransaction;
}

describe('withdrawal payment plan', () => {
  it('carries the anchor account, amount and memo', () => {
    const plan = planWithdrawalPayment(withdrawal(), '20');

    expect(plan.destination).toBe('GCLCZEQZ2THTEDAOFI66LACNPLY4OBKN7VKLEZFMBIHYKYQOW2W7T3Z6');
    expect(plan.amount).toBe('20');
    expect(plan.memo).toBe('702799274298');
    expect(plan.memoType).toBe('id');
  });

  it('refuses to plan a payment with no memo', () => {
    // Paying without the memo strands the USDC at the anchor with nothing
    // tying it to this withdrawal, so this must fail before the user signs.
    expect(() => planWithdrawalPayment(withdrawal(['withdrawMemo']), '20')).toThrowError(
      /payment reference/i,
    );
    expect(() => planWithdrawalPayment(withdrawal(['withdrawMemoType']), '20')).toThrowError(
      /payment reference/i,
    );
  });

  it('refuses to plan a payment with no destination', () => {
    expect(() => planWithdrawalPayment(withdrawal(['withdrawAnchorAccount']), '20')).toThrowError(
      /where to send/i,
    );
  });

  it('preserves text and hash memo types', () => {
    expect(planWithdrawalPayment(withdrawal([], { withdrawMemoType: 'text' }), '1').memoType).toBe(
      'text',
    );
    expect(planWithdrawalPayment(withdrawal([], { withdrawMemoType: 'hash' }), '1').memoType).toBe(
      'hash',
    );
  });
});

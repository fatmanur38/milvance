import { describe, expect, it } from 'vitest';

import { finance, milestone, offer, position } from '../test/fixtures';
import { moneyView } from './money';

describe('buyer protected money vs funder advance', () => {
  it('keeps the two pools separate and never sums them', () => {
    const view = moneyView(milestone(), finance({ positions: [position()] }));

    // AGENTS.md canonical example: 2,000 protected, 1,400 advanced, 1,445 repaid.
    expect(view.protectedHeld).toBe('20000000000');
    expect(view.advance?.principal).toBe('14000000000');
    expect(view.expectedOnVerification).toEqual({
      funderRepayment: '14450000000',
      supplierRemainder: '5550000000', // 555 USDC
      awaitingSettlement: false,
    });
    // No field anywhere represents "protected + advance".
    expect(Object.values(view)).not.toContain('34000000000');
  });

  it('shows an accepted-but-unfunded offer as pending, not as money received', () => {
    const view = moneyView(
      milestone({ status: 'FINANCE_REQUESTED' }),
      finance({ offers: [offer({ status: 'ACCEPTED' })] }),
    );
    expect(view.advance).toBeNull();
    expect(view.pendingAdvance?.principal).toBe('14000000000');
  });

  it('pays the whole protected amount to the supplier when unfinanced', () => {
    const view = moneyView(milestone(), finance());
    expect(view.expectedOnVerification).toEqual({
      funderRepayment: '0',
      supplierRemainder: '20000000000',
      awaitingSettlement: false,
    });
  });

  it('marks the split as waiting once the attestor has verified it', () => {
    const pending = moneyView(milestone(), finance({ positions: [position()] }));
    expect(pending.expectedOnVerification?.awaitingSettlement).toBe(false);

    const verified = moneyView(
      milestone({ status: 'VERIFIED' }),
      finance({ positions: [position()] }),
    );
    // Same money, different moment: verification does not move anything.
    expect(verified.expectedOnVerification?.funderRepayment).toBe('14450000000');
    expect(verified.expectedOnVerification?.supplierRemainder).toBe('5550000000');
    expect(verified.expectedOnVerification?.awaitingSettlement).toBe(true);
    expect(verified.settlement).toBeNull();
  });

  it('uses the chain-reported settlement once the milestone is paid', () => {
    const settlement = {
      protectedAmount: '20000000000',
      funderRepayment: '14450000000',
      supplierPayout: '5550000000',
      settledAt: '2026-09-20T00:00:00.000Z',
      settledTxHash: 'c'.repeat(64),
    };
    const view = moneyView(
      milestone({ status: 'SETTLED', fundedAmount: '0' }),
      finance({ positions: [position({ status: 'REPAID' })], settlement }),
    );
    expect(view.settlement).toEqual(settlement);
    expect(view.expectedOnVerification).toBeNull();
    // The advance stays visible historically — the supplier did receive it.
    expect(view.advance?.status).toBe('REPAID');
  });

  it('records that a refund does not claw back the advance', () => {
    const refund = {
      refundedAmount: '20000000000',
      funderAdvanceOutstanding: '14000000000',
      refundedAt: '2026-09-20T00:00:00.000Z',
      refundedTxHash: 'd'.repeat(64),
    };
    const view = moneyView(
      milestone({ status: 'REFUNDED', fundedAmount: '0' }),
      finance({ positions: [position({ status: 'CLOSED' })], refund }),
    );
    expect(view.refund?.funderAdvanceOutstanding).toBe('14000000000');
    expect(view.advance?.status).toBe('CLOSED');
  });
});

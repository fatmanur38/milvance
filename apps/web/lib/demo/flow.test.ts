import { describe, expect, it } from 'vitest';

import { buildFlow, flowScale } from './flow';
import type { TourStep } from './tour';

/**
 * The animation's arithmetic.
 *
 * A picture that moves the wrong money is worse than no picture, so these
 * tests pin the two claims the drawing makes: the funder's advance never
 * passes through escrow, and settlement empties escrow into exactly two
 * places without paying the advance a second time.
 */
let sequence = 0;
function step(overrides: Partial<TourStep>): TourStep {
  sequence += 1;
  return {
    id: `step-${sequence}`,
    theme: 'setup',
    title: 'A step',
    detail: 'Something happened.',
    actor: 'Buyer',
    amount: null,
    amountMeans: null,
    txHash: String(sequence).padStart(64, '0'),
    ledger: String(4_760_000 + sequence),
    at: new Date(1_789_830_000_000 + sequence * 60_000).toISOString(),
    ...overrides,
  };
}

const PROTECTED = '100000000'; // 10 USDC
const PRINCIPAL = '80000000'; // 8 USDC
const REPAYMENT = '90000000'; // 9 USDC
const REMAINDER = '10000000'; // 1 USDC

const financedTrade = () =>
  buildFlow([
    step({ title: 'created' }),
    step({ title: 'protected', amount: PROTECTED, amountMeans: 'protected', actor: 'Buyer' }),
    step({ title: 'advanced', amount: PRINCIPAL, amountMeans: 'advanced', actor: 'Funder' }),
    step({ title: 'verified', actor: 'Attestor' }),
    step({
      title: 'settled',
      amount: PROTECTED,
      amountMeans: 'repaid',
      actor: 'Contract',
      settlement: { funderRepayment: REPAYMENT, supplierPayout: REMAINDER },
    }),
  ]);

describe('the funder’s advance never touches escrow', () => {
  it('travels from the funder straight to the supplier', () => {
    const advance = financedTrade()[2]!;
    expect(advance.transfers).toHaveLength(1);
    expect(advance.transfers[0]).toMatchObject({
      from: 'funder',
      to: 'supplier',
      amount: PRINCIPAL,
      pool: 'advance',
    });
  });

  it('leaves the escrow balance completely unchanged', () => {
    const frames = financedTrade();
    // 10 protected, then 8 advanced: escrow is still 10, not 18 and not 2.
    expect(frames[1]!.balances.escrow).toBe(PROTECTED);
    expect(frames[2]!.balances.escrow).toBe(PROTECTED);
  });

  it('is drawn in a different pool from protected money', () => {
    const frames = financedTrade();
    expect(frames[1]!.transfers[0]!.pool).toBe('protected');
    expect(frames[2]!.transfers[0]!.pool).toBe('advance');
  });
});

describe('settlement', () => {
  it('moves two amounts in one transaction, funder first', () => {
    const settled = financedTrade()[4]!;
    expect(settled.transfers).toHaveLength(2);
    expect(settled.transfers[0]).toMatchObject({
      to: 'funder',
      amount: REPAYMENT,
      label: 'repaid first',
    });
    expect(settled.transfers[1]).toMatchObject({ to: 'supplier', amount: REMAINDER });
  });

  it('empties escrow exactly, with nothing left over and nothing conjured', () => {
    const settled = financedTrade()[4]!;
    expect(settled.balances.escrow).toBe('0');
    const out = settled.transfers.reduce((total, transfer) => total + BigInt(transfer.amount), 0n);
    expect(out).toBe(BigInt(PROTECTED));
  });

  it('does not pay the advance a second time', () => {
    const frames = financedTrade();
    // The supplier received 8 from the funder and 1 from escrow. Nine, not 17.
    expect(frames[4]!.balances.supplier).toBe('90000000');
    expect(frames[4]!.balances.funderExposed).toBe('0');
  });
});

describe('a refund', () => {
  it('returns escrow to the buyer and leaves the advance outstanding', () => {
    const frames = buildFlow([
      step({ amount: PROTECTED, amountMeans: 'protected' }),
      step({ amount: PRINCIPAL, amountMeans: 'advanced', actor: 'Funder' }),
      step({ amount: PROTECTED, amountMeans: 'refunded', actor: 'Resolver' }),
    ]);
    const refunded = frames[2]!;
    expect(refunded.transfers[0]).toMatchObject({ from: 'escrow', to: 'buyer', amount: PROTECTED });
    expect(refunded.balances.escrow).toBe('0');
    expect(refunded.balances.buyerRefunded).toBe(PROTECTED);
    // The supplier keeps the advance and the funder is still out of pocket —
    // the picture must not quietly settle that.
    expect(refunded.balances.supplier).toBe(PRINCIPAL);
    expect(refunded.balances.funderExposed).toBe(PRINCIPAL);
  });
});

describe('frames without money', () => {
  it('move nothing and only change who is emphasised', () => {
    const frames = buildFlow([step({ actor: 'Attestor' }), step({ actor: 'Supplier' })]);
    expect(frames[0]!.transfers).toHaveLength(0);
    expect(frames[0]!.active).toEqual(['escrow']);
    expect(frames[1]!.active).toEqual(['supplier']);
  });

  it('carry the balances forward untouched', () => {
    const frames = buildFlow([
      step({ amount: PROTECTED, amountMeans: 'protected' }),
      step({ actor: 'Attestor' }),
    ]);
    expect(frames[1]!.balances).toEqual(frames[0]!.balances);
  });
});

describe('scaling the meters', () => {
  it('uses one scale across every party, so 8 never looks like 10', () => {
    expect(flowScale(financedTrade())).toBe(BigInt(PROTECTED));
  });

  it('never divides by zero on a trade where nothing has moved', () => {
    expect(flowScale(buildFlow([step({})]))).toBe(1n);
    expect(flowScale([])).toBe(1n);
  });
});

describe('every frame stays tied to its transaction', () => {
  it('keeps the step id, so a frame can always be checked on Stellar', () => {
    const steps = [step({ amount: PROTECTED, amountMeans: 'protected' }), step({})];
    expect(buildFlow(steps).map((frame) => frame.stepId)).toEqual(steps.map((s) => s.id));
  });
});

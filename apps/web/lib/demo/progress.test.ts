import { describe, expect, it } from 'vitest';

import { finance, milestone, offer, order, position } from '../test/fixtures';
import { demoProgress } from './progress';

const withMilestone = (m: ReturnType<typeof milestone>) => order({ milestones: [m] });

const stateOf = (progress: ReturnType<typeof demoProgress>, id: string) =>
  progress.steps.find((step) => step.id === id)?.state;

describe('demo progress', () => {
  it('reads every step from the read model, not from a local tally', () => {
    const draft = demoProgress(
      order({
        status: 'CREATED',
        milestones: [milestone({ status: 'UNFUNDED', fundedAmount: '0', fullyFunded: false })],
      }),
      0,
      finance({ buyerProtectedEscrow: '0' }),
    );
    expect(stateOf(draft, 'created')).toBe('done');
    expect(stateOf(draft, 'accepted')).toBe('now');
    expect(stateOf(draft, 'protected')).toBe('later');
    expect(draft.done).toBe(1);
    expect(draft.total).toBe(10);
  });

  it('advances only when the chain says so', () => {
    const funded = demoProgress(
      withMilestone(milestone({ status: 'FUNDED' })),
      0,
      finance({ buyerProtectedEscrow: '20000000000' }),
    );
    expect(stateOf(funded, 'accepted')).toBe('done');
    expect(stateOf(funded, 'protected')).toBe('done');
    expect(stateOf(funded, 'requested')).toBe('now');
    expect(stateOf(funded, 'advanced')).toBe('later');
  });

  it('counts an advance only once a finance position exists', () => {
    const chosen = demoProgress(
      withMilestone(milestone({ status: 'FINANCE_REQUESTED' })),
      0,
      finance({ request: null, offers: [offer({ status: 'ACCEPTED' })] }),
    );
    // The supplier chose an offer; the funder has not sent anything yet.
    expect(stateOf(chosen, 'chosen')).toBe('done');
    expect(stateOf(chosen, 'advanced')).toBe('now');

    const advanced = demoProgress(
      withMilestone(milestone({ status: 'FINANCED' })),
      0,
      finance({ offers: [offer({ status: 'FUNDED' })], positions: [position()] }),
    );
    expect(stateOf(advanced, 'advanced')).toBe('done');
  });

  it('treats a verified milestone as past every earlier step', () => {
    const verified = demoProgress(
      withMilestone(milestone({ status: 'VERIFIED', evidenceHash: 'b'.repeat(64) })),
      0,
      finance({ positions: [position()] }),
    );
    expect(stateOf(verified, 'evidenced')).toBe('done');
    expect(stateOf(verified, 'verified')).toBe('done');
    expect(stateOf(verified, 'settled')).toBe('now');
  });

  it('shows a settled trade as finished, using the chain settlement', () => {
    const settled = demoProgress(
      order({
        status: 'COMPLETED',
        milestones: [milestone({ status: 'SETTLED', fundedAmount: '0', fullyFunded: false })],
      }),
      0,
      finance({
        positions: [position({ status: 'REPAID' })],
        settlement: {
          protectedAmount: '20000000000',
          funderRepayment: '14450000000',
          supplierPayout: '5550000000',
          settledAt: '2026-09-20T00:00:00.000Z',
          settledTxHash: 'c'.repeat(64),
        },
      }),
    );
    expect(stateOf(settled, 'settled')).toBe('done');
    expect(settled.complete).toBe(true);
    expect(settled.done).toBe(settled.total);
  });

  it('does not pretend a refunded milestone was settled', () => {
    const refunded = demoProgress(
      order({
        status: 'COMPLETED',
        milestones: [milestone({ status: 'REFUNDED', fundedAmount: '0', fullyFunded: false })],
      }),
      0,
      finance({ buyerProtectedEscrow: '0' }),
    );
    // The money went back to the buyer. Marking settlement "done" would be a
    // lie about where the money went, and "now" would be worse.
    expect(stateOf(refunded, 'settled')).toBe('skipped');
    expect(stateOf(refunded, 'verified')).toBe('skipped');
    expect(stateOf(refunded, 'protected')).toBe('done');
    // Nothing is left waiting on anyone: this trade ended.
    expect(refunded.steps.some((step) => step.state === 'now')).toBe(false);
    expect(refunded.complete).toBe(true);
  });

  it('stays honest while the finance query is still loading', () => {
    const loading = demoProgress(withMilestone(milestone({ status: 'FUNDED' })), 0, undefined);
    expect(stateOf(loading, 'protected')).toBe('done');
    expect(stateOf(loading, 'requested')).toBe('now');
    expect(stateOf(loading, 'advanced')).toBe('later');
  });
});

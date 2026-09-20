import { describe, expect, it } from 'vitest';

import type { ActivityItem, OrderWithMilestones } from '../api/schemas';
import { milestone, order } from '../test/fixtures';
import { buildTour, pickTourOrder, tourIsTellable } from './tour';

/**
 * The guided tour narrates real events and must be incapable of narrating
 * anything else. These tests pin that: a step cannot exist without an indexed
 * transaction behind it, amounts come from the event, and the two money pools
 * stay distinguishable in the narration itself.
 */
let sequence = 0;
function event(eventName: string, fields: Record<string, unknown>): ActivityItem {
  sequence += 1;
  return {
    eventId: `event-${sequence}`,
    eventName,
    ledger: String(4_760_000 + sequence),
    txHash: String(sequence).padStart(64, '0'),
    ledgerClosedAt: new Date(1_789_830_000_000 + sequence * 60_000).toISOString(),
    projected: true,
    fields,
  };
}

/** The API returns newest first; the tour must read a story oldest first. */
function feed(...events: ActivityItem[]): ActivityItem[] {
  return [...events].reverse();
}

const trade: OrderWithMilestones = order({
  orderId: '2',
  status: 'COMPLETED',
  milestones: [
    milestone({ milestoneId: '2', status: 'SETTLED' }),
    milestone({ milestoneId: '3', status: 'REFUNDED' }),
  ],
});

const fullHistory = () =>
  feed(
    event('order_created', { order_id: '2' }),
    event('milestone_created', { order_id: '2', milestone_id: '2', amount: '100000000' }),
    event('order_accepted', { order_id: '2' }),
    event('milestone_funded', {
      order_id: '2',
      milestone_id: '2',
      amount: '100000000',
      fully_funded: true,
    }),
    event('finance_requested', { milestone_id: '2', requested_principal: '80000000' }),
    event('funding_offer_created', { milestone_id: '2', principal: '80000000' }),
    event('offer_accepted', { milestone_id: '2', repayment: '90000000' }),
    event('advance_funded', { milestone_id: '2', principal: '80000000', repayment: '90000000' }),
    event('evidence_submitted', { milestone_id: '2' }),
    event('milestone_verified', { milestone_id: '2' }),
    event('milestone_settled', {
      order_id: '2',
      milestone_id: '2',
      protected_amount: '100000000',
      funder_repayment: '90000000',
      supplier_payout: '10000000',
    }),
    event('order_completed', { order_id: '2' }),
  );

describe('building the tour from real events', () => {
  it('tells the story oldest first, one step per meaningful transaction', () => {
    const steps = buildTour(trade, fullHistory());
    expect(steps.map((step) => step.title)).toEqual([
      'A buyer opens a trade',
      'A payment stage is defined',
      'The supplier accepts',
      'The buyer protects the payment',
      'The supplier asks for working capital',
      'A funder makes an offer',
      'The supplier picks an offer',
      'The funder pays the supplier, now',
      'The supplier submits evidence',
      'The attestor verifies the work',
      'The contract settles, funder first',
      'Every stage is finished',
    ]);
  });

  it('carries the real transaction hash and ledger on every step', () => {
    const steps = buildTour(trade, fullHistory());
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      // A step that cannot be checked against Stellar has no business existing.
      expect(step.txHash).toMatch(/^[0-9a-f]{64}$/);
      expect(step.ledger).toMatch(/^\d+$/);
      expect(() => new Date(step.at).toISOString()).not.toThrow();
    }
  });

  it('takes amounts from the event, never from anywhere else', () => {
    const steps = buildTour(trade, fullHistory());
    const protectedStep = steps.find((step) => step.amountMeans === 'protected');
    const advance = steps.find((step) => step.amountMeans === 'advanced');
    expect(protectedStep?.amount).toBe('100000000');
    expect(advance?.amount).toBe('80000000');
  });

  it('keeps buyer escrow and funder advance distinguishable in the narration', () => {
    const steps = buildTour(trade, fullHistory());
    const advance = steps.find((step) => step.amountMeans === 'advanced');
    expect(advance?.detail).toMatch(/their own USDC/i);
    expect(advance?.lesson).toMatch(/two separate pools/i);
    // 10 protected + 8 advanced must never be narrated as one 18 USDC figure.
    expect(JSON.stringify(steps)).not.toContain('180000000');
  });

  it('is honest that a refund does not reverse a financed advance', () => {
    const financed = buildTour(
      trade,
      feed(
        event('milestone_funded', { milestone_id: '2', amount: '100000000', fully_funded: true }),
        event('milestone_refunded', {
          order_id: '2',
          milestone_id: '2',
          refunded_amount: '100000000',
          funder_advance_outstanding: '80000000',
        }),
      ),
    );
    expect(financed.at(-1)?.lesson).toMatch(/does not claw back/i);

    const unfinanced = buildTour(
      trade,
      feed(
        event('milestone_funded', { milestone_id: '3', amount: '100000000', fully_funded: true }),
        event('milestone_refunded', {
          order_id: '2',
          milestone_id: '3',
          refunded_amount: '100000000',
          funder_advance_outstanding: '0',
        }),
      ),
    );
    expect(unfinanced.at(-1)?.lesson).toMatch(/never financed/i);
  });

  it('never claims the chain verified the physical goods', () => {
    const steps = buildTour(trade, fullHistory());
    const evidence = steps.find((step) => step.title.includes('evidence'));
    expect(evidence?.lesson).toMatch(/does not prove the file is honest/i);
    expect(JSON.stringify(steps)).not.toMatch(/trustless|guaranteed|risk-free/i);
  });
});

describe('what the tour refuses to narrate', () => {
  it('ignores events belonging to another trade', () => {
    const steps = buildTour(
      trade,
      feed(
        event('order_created', { order_id: '2' }),
        event('order_created', { order_id: '9' }),
        event('milestone_funded', { milestone_id: '99', amount: '500000000' }),
      ),
    );
    expect(steps).toHaveLength(1);
    expect(JSON.stringify(steps)).not.toContain('500000000');
  });

  it('ignores an event the read model did not project', () => {
    const unprojected = {
      ...event('milestone_funded', { order_id: '2', amount: '1' }),
      projected: false,
    };
    expect(buildTour(trade, [unprojected])).toHaveLength(0);
  });

  it('ignores events it has no narration for, rather than printing a raw name', () => {
    const steps = buildTour(trade, feed(event('some_future_event', { order_id: '2' })));
    expect(steps).toHaveLength(0);
  });

  it('has nothing to tell before a milestone has been protected', () => {
    const steps = buildTour(trade, feed(event('order_created', { order_id: '2' })));
    expect(tourIsTellable(steps)).toBe(false);
    expect(tourIsTellable(buildTour(trade, fullHistory()))).toBe(true);
  });
});

describe('choosing which trade to show', () => {
  it('prefers a completed trade, because it tells the whole story', () => {
    const chosen = pickTourOrder([
      order({ orderId: '1', status: 'CREATED' }),
      order({ orderId: '2', status: 'COMPLETED' }),
      order({ orderId: '3', status: 'ACTIVE' }),
    ]);
    expect(chosen?.orderId).toBe('2');
  });

  it('falls back to the one that got furthest', () => {
    expect(
      pickTourOrder([
        order({ orderId: '1', status: 'CREATED' }),
        order({ orderId: '2', status: 'ACTIVE' }),
      ])?.orderId,
    ).toBe('2');
  });

  it('prefers the newest when several are equally far along', () => {
    // Chain ids are u64, so this must not be a string comparison.
    expect(
      pickTourOrder([
        order({ orderId: '9', status: 'COMPLETED' }),
        order({ orderId: '10', status: 'COMPLETED' }),
      ])?.orderId,
    ).toBe('10');
  });

  it('has no opinion when nothing exists', () => {
    expect(pickTourOrder([])).toBeNull();
  });
});

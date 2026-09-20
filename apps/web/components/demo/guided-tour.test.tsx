// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ActivityItem } from '@/lib/api/schemas';
import { milestone, order } from '@/lib/test/fixtures';
import { renderWithData } from '@/test/render';

import { GuidedTour } from './guided-tour';

/**
 * The judge-facing tour.
 *
 * It must work with no wallet, show real transactions, and never let the two
 * money pools read as one number. It must also be willing to say it has
 * nothing to show, which is the property that stops it becoming a demo mode.
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

const trade = order({
  orderId: '2',
  status: 'COMPLETED',
  milestones: [milestone({ milestoneId: '2', status: 'SETTLED' })],
});

const history = () =>
  [
    event('order_created', { order_id: '2' }),
    event('milestone_funded', { order_id: '2', milestone_id: '2', amount: '100000000' }),
    event('advance_funded', { milestone_id: '2', principal: '80000000' }),
    event('milestone_verified', { milestone_id: '2' }),
    event('milestone_settled', {
      order_id: '2',
      milestone_id: '2',
      protected_amount: '100000000',
      funder_repayment: '90000000',
      supplier_payout: '10000000',
    }),
  ].reverse();

function show(activity: ActivityItem[] = history(), orders = [trade]) {
  return renderWithData(<GuidedTour />, { allOrders: orders, activity });
}

describe('the tour a judge sees', () => {
  it('needs no wallet at all', () => {
    // Rendered without a wallet provider mock: connecting one is not a
    // prerequisite for understanding the product.
    show();
    expect(screen.getAllByTestId('tour-step').length).toBe(5);
  });

  it('says up front that it is real history, not a simulation', () => {
    show();
    expect(screen.getByText(/real history, not a simulation/i)).toBeTruthy();
    expect(screen.getByText(/you are reading the ledger/i)).toBeTruthy();
  });

  it('links every step to the transaction that produced it', () => {
    const { container } = show();
    const links = [...container.querySelectorAll('a[href*="stellar.expert"]')];
    expect(links.length).toBe(5);
    for (const link of links) {
      expect(link.getAttribute('href')).toMatch(/\/tx\/[0-9a-f]{64}$/);
    }
  });

  it('shows who signed each step, by role rather than by address', () => {
    const { container } = show();
    expect(screen.getAllByText(/Buyer signed this/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Funder signed this/).length).toBeGreaterThan(0);
    // A tour is not a directory of wallet addresses.
    expect(container.textContent).not.toMatch(/G[A-Z2-7]{55}/);
  });

  it('never merges buyer escrow with the funder advance', () => {
    const { container } = show();
    // Protected once, released once — both 10.00, and neither is the advance.
    expect(screen.getAllByText('10.00 USDC').length).toBe(2);
    expect(screen.getByText('8.00 USDC')).toBeTruthy();
    expect(container.textContent).not.toMatch(/18\.00 USDC/);
    const advance = screen.getAllByTestId('tour-step')[2];
    expect(
      within(advance!).getByText(/advanced by the funder, from their own money/i),
    ).toBeTruthy();
  });

  it('offers the real product as the next step, not a sandbox', () => {
    show();
    expect(screen.getByRole('link', { name: /Open Trade Lab/i }).getAttribute('href')).toBe(
      '/app/trade-lab',
    );
    expect(screen.getByText(/same product you can use/i)).toBeTruthy();
  });
});

describe('when there is nothing real to show', () => {
  it('says so instead of inventing a trade', () => {
    show([event('order_created', { order_id: '2' })], [order({ orderId: '2', status: 'CREATED' })]);
    expect(screen.getByText(/No finished trade to walk through yet/i)).toBeTruthy();
    expect(screen.queryAllByTestId('tour-step')).toHaveLength(0);
    // The way out is the real product, not a simulated mode.
    expect(screen.getByRole('link', { name: 'Trade Lab' }).getAttribute('href')).toBe(
      '/app/trade-lab',
    );
  });

  it('says so when the contract has no trades at all', () => {
    show([], []);
    expect(screen.getByText(/No finished trade to walk through yet/i)).toBeTruthy();
  });
});

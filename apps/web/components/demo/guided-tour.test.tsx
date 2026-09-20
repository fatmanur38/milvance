// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react';
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
    expect(screen.getByTestId('tour-step')).toBeTruthy();
  });

  it('opens on the first real money movement, with one step of explanation', () => {
    show();
    for (const party of ['buyer', 'escrow', 'supplier', 'funder']) {
      expect(screen.getByTestId(`flow-node-${party}`)).toBeTruthy();
    }
    expect(screen.getByTestId('flow-coin').getAttribute('data-amount')).toBe('100000000');
    expect(screen.getAllByTestId('tour-step')).toHaveLength(1);
  });

  it('lets a reader scrub the timeline instead of scrolling', () => {
    show();
    fireEvent.change(screen.getByRole('slider', { name: 'Trade timeline' }), {
      target: { value: '2' },
    });
    // Step 3 is the advance: the funder's own money, going straight across.
    const coin = screen.getByTestId('flow-coin');
    expect(coin.getAttribute('data-amount')).toBe('80000000');
    expect(screen.getByTestId('tour-step').textContent).toMatch(/funder pays the supplier/i);
  });

  it('shows the advance leaving the funder, not the escrow', () => {
    show();
    fireEvent.change(screen.getByRole('slider', { name: 'Trade timeline' }), {
      target: { value: '2' },
    });
    const escrow = screen.getByTestId('flow-node-escrow');
    // Escrow still holds the full protected amount while the advance moves.
    expect(escrow.textContent).toContain('10.00');
  });

  it('moves two amounts at once when the contract settles', () => {
    show();
    fireEvent.change(screen.getByRole('slider', { name: 'Trade timeline' }), {
      target: { value: '4' },
    });
    const coins = screen
      .getAllByTestId('flow-coin')
      .map((coin) => coin.getAttribute('data-amount'));
    // One transaction, two destinations: 9 to the funder, 1 to the supplier.
    expect(coins).toEqual(['90000000', '10000000']);
  });

  it('explains a selected role without changing the transaction', () => {
    show();
    fireEvent.click(screen.getByTestId('flow-node-escrow'));
    expect(screen.getByText(/never sends the early working-capital advance/i)).toBeTruthy();
    expect(screen.getByTestId('flow-coin').getAttribute('data-amount')).toBe('100000000');
  });

  it('lets a keyboard user select a role in the map', () => {
    show();
    fireEvent.keyDown(screen.getByTestId('flow-node-funder'), { key: 'Enter' });
    expect(screen.getByText(/funder sends its own capital to the supplier/i)).toBeTruthy();
  });

  it('says up front that it is real history, not a simulation', () => {
    show();
    expect(screen.getByText(/real history, not a simulation/i)).toBeTruthy();
    expect(screen.getByText(/you are reading the ledger/i)).toBeTruthy();
  });

  it('links the step it is showing to the transaction that produced it', () => {
    const { container } = show();
    const links = [...container.querySelectorAll('a[href*="stellar.expert"]')];
    expect(links.length).toBe(1);
    expect(links[0]?.getAttribute('href')).toMatch(/\/tx\/[0-9a-f]{64}$/);
  });

  it('keeps every event reachable, one disclosure away', () => {
    show();
    const list = screen.getByText(/All 5 on-chain steps/i);
    expect(list).toBeTruthy();
  });

  it('shows who signed the step, by role rather than by address', () => {
    const { container } = show();
    expect(screen.getByText(/Buyer signed this/)).toBeTruthy();
    // A tour is not a directory of wallet addresses.
    expect(container.textContent).not.toMatch(/G[A-Z2-7]{55}/);
  });

  it('never merges buyer escrow with the funder advance', () => {
    const { container } = show();
    // 10 protected + 8 advanced must never be drawn or written as 18.
    expect(container.textContent).not.toMatch(/18\.00/);
    expect(screen.getByText(/Buyer’s protected payment/)).toBeTruthy();
    expect(screen.getByText(/Funder’s own capital/)).toBeTruthy();
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

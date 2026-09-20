// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { order, WALLETS } from '@/lib/test/fixtures';
import { renderWithData } from '@/test/render';

import { OrderList } from './order-list';

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('order list states', () => {
  it('shows a loading state while the read model answers', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => undefined)),
    );
    renderWithData(<OrderList wallet={WALLETS.buyer} />);
    expect(screen.getByRole('status').textContent).toMatch(/Loading your orders/);
  });

  it('explains an unreachable service without inventing data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    renderWithData(<OrderList wallet={WALLETS.buyer} />);
    expect(await screen.findByText(/Your funds are unaffected/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('rejects a response that does not match the expected shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ orders: [{ orderId: 1 }] }), { status: 200 }),
      ),
    );
    renderWithData(<OrderList wallet={WALLETS.buyer} />);
    expect(
      await screen.findByText(/nothing is shown rather than something possibly wrong/),
    ).toBeTruthy();
  });

  it('has a real empty state', () => {
    renderWithData(<OrderList wallet={WALLETS.outsider} />, {
      orders: { participant: WALLETS.outsider, orders: [] },
    });
    expect(screen.getByText('No orders yet')).toBeTruthy();
  });

  it('lists orders with the wallet’s role derived from chain assignments', () => {
    renderWithData(<OrderList wallet={WALLETS.supplier} />, {
      orders: { participant: WALLETS.supplier, orders: [order()] },
    });
    expect(screen.getByText('Order #1')).toBeTruthy();
    expect(screen.getByText('Supplier')).toBeTruthy();
    expect(screen.queryByText('Buyer')).toBeNull();
    expect(screen.getByRole('link').getAttribute('href')).toBe('/app/orders/1');
  });
});

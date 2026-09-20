// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { queryKeys } from '@/lib/api/queries';
import type { WalletState } from '@/lib/wallet/controller';
import { milestone, openRequest, order, WALLETS } from '@/lib/test/fixtures';

import { FundingView } from './funding-view';

vi.mock('@/lib/wallet/provider', () => ({
  useWallet: () => ({ controller: {}, state: { phase: 'disconnected' } as WalletState }),
}));

function renderFunding(wallet: string | undefined, expiresAt?: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => undefined)),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(queryKeys.opportunities, {
    opportunities: [
      {
        ...openRequest(expiresAt),
        milestone: milestone({ status: 'FINANCE_REQUESTED' }),
        order: order(),
      },
    ],
  });
  if (wallet) {
    client.setQueryData(queryKeys.funderOffers(wallet), { offers: [] });
    client.setQueryData(queryKeys.positions(wallet), { positions: [] });
  }
  return render(
    <QueryClientProvider client={client}>
      <FundingView wallet={wallet} />
    </QueryClientProvider>,
  );
}

describe('funder opportunities', () => {
  it('shows protected money and the supplier’s need as two different things', () => {
    renderFunding(WALLETS.funder);
    expect(screen.getByText('Protected by buyer')).toBeTruthy();
    expect(screen.getByText('Supplier needs now')).toBeTruthy();
    expect(screen.getByText('You would send this from your own wallet.')).toBeTruthy();
  });

  it('invites an independent wallet to review and offer', () => {
    renderFunding(WALLETS.funder);
    expect(
      screen.getByRole('link', { name: 'Review and make an offer' }).getAttribute('href'),
    ).toBe('/app/orders/1#milestone-1');
  });

  it('tells an order party it cannot fund its own order', () => {
    renderFunding(WALLETS.buyer);
    expect(screen.queryByRole('link', { name: 'Review and make an offer' })).toBeNull();
    expect(screen.getByText(/Funders must be independent/)).toBeTruthy();
  });

  it('does not invite offers on an expired request', () => {
    renderFunding(WALLETS.funder, '2020-01-01T00:00:00.000Z');
    expect(screen.getByText('Expired')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Review and make an offer' })).toBeNull();
  });

  it('never promises a guaranteed return', () => {
    const { container } = renderFunding(WALLETS.funder);
    expect(screen.getByText('This is not a guaranteed return')).toBeTruthy();
    expect(container.textContent).not.toMatch(/risk-free|guaranteed repayment|guaranteed yield/i);
  });

  it('has an empty state for a new funder', () => {
    renderFunding(WALLETS.funder);
    expect(screen.getByText('You have not made any offers')).toBeTruthy();
    expect(screen.getByText('No funded positions yet')).toBeTruthy();
  });
});

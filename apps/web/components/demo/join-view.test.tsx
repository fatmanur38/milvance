// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WalletState } from '@/lib/wallet/controller';
import { milestone, order, WALLETS } from '@/lib/test/fixtures';
import { renderWithData } from '@/test/render';

import { JoinView } from './join-view';

const wallet = vi.hoisted(() => ({ state: { phase: 'disconnected' } as WalletState }));
vi.mock('@/lib/wallet/provider', () => ({
  useWallet: () => ({ controller: { connect: vi.fn(), refresh: vi.fn() }, state: wallet.state }),
}));

function connect(address: string) {
  wallet.state = { phase: 'connected', address, trustline: 'present' };
}

const data = order({
  orderId: '2',
  status: 'ACTIVE',
  milestones: [milestone({ status: 'FUNDED' })],
});

function open(params: Record<string, string>) {
  return renderWithData(<JoinView params={params} />, { order: data });
}

beforeEach(() => {
  wallet.state = { phase: 'disconnected' };
});

describe('opening an invite', () => {
  it('explains the role it was sent for', () => {
    open({ order: '2', role: 'attestor' });
    expect(screen.getByText(/invited as Attestor/i)).toBeTruthy();
    expect(screen.getByText(/check the evidence/i)).toBeTruthy();
  });

  it('refuses a malformed link instead of following it', () => {
    renderWithData(<JoinView params={{ order: '0', role: 'attestor' }} />, { order: data });
    expect(screen.getByText(/not valid/i)).toBeTruthy();
    expect(screen.queryByText(/invited as/i)).toBeNull();
  });

  it('refuses a role nobody has', () => {
    renderWithData(<JoinView params={{ order: '2', role: 'admin' }} />, { order: data });
    expect(screen.getByText(/unknown role/i)).toBeTruthy();
  });

  it('does not reflect markup from a crafted link', () => {
    const { container } = renderWithData(
      <JoinView params={{ order: '2', role: '<img src=x onerror=alert(1)>' }} />,
      { order: data },
    );
    expect(container.innerHTML).not.toContain('onerror');
    expect(container.querySelector('img')).toBeNull();
  });
});

/**
 * The security property of the whole invite mechanism: the `role` in a URL is
 * a word on a page. It cannot make the contract accept anything.
 */
describe('a role in a link grants nothing', () => {
  it('tells a stranger holding an attestor link that it is not their wallet', () => {
    connect(WALLETS.outsider);
    open({ order: '2', role: 'attestor' });

    expect(screen.getByText(/not the wallet this role expects/i)).toBeTruthy();
    // No attestor control appears anywhere on the page.
    expect(screen.queryByRole('button', { name: /verify/i })).toBeNull();
    expect(screen.queryByText(/Verify this milestone/i)).toBeNull();
  });

  it('names the wallet the contract actually expects', () => {
    connect(WALLETS.outsider);
    const { container } = open({ order: '2', role: 'supplier' });
    // The page shows the address the order carries, so the reader can check it,
    // with the full value in the element's title.
    expect(container.textContent).toContain(WALLETS.supplier.slice(0, 4));
    expect(container.querySelector(`[title="${WALLETS.supplier}"]`)).not.toBeNull();
  });

  it('tells the right wallet that it matches', () => {
    connect(WALLETS.attestor);
    open({ order: '2', role: 'attestor' });
    expect(screen.getByText(/This wallet matches/i)).toBeTruthy();
    expect(screen.queryByText(/not the wallet this role expects/i)).toBeNull();
  });

  it('points out when the connected wallet holds a different role here', () => {
    connect(WALLETS.buyer);
    open({ order: '2', role: 'supplier' });
    expect(screen.getByText(/not the wallet this role expects/i)).toBeTruthy();
    expect(screen.getByText(/is the Buyer here/i)).toBeTruthy();
  });

  it('lets an unconnected visitor read the trade without claiming a role', () => {
    open({ order: '2', role: 'resolver' });
    expect(screen.getByText(/Connect your wallet to continue/i)).toBeTruthy();
    expect(screen.getByText(/everything on it is public/i)).toBeTruthy();
  });
});

describe('a funder invite', () => {
  it('accepts any wallet that is independent of the four parties', () => {
    connect(WALLETS.funder);
    open({ order: '2', role: 'funder' });
    expect(screen.getByText(/This wallet matches/i)).toBeTruthy();
    expect(screen.getByText(/independent of this trade/i)).toBeTruthy();
  });

  it('refuses a party of the trade, as the contract does', () => {
    connect(WALLETS.supplier);
    open({ order: '2', role: 'funder' });
    // InvalidFunder: a funder may not be the buyer, supplier, attestor or resolver.
    expect(screen.getByText(/not the wallet this role expects/i)).toBeTruthy();
    expect(screen.getByText(/has to be independent of all four parties/i)).toBeTruthy();
  });

  it('says a funder has no expected address, rather than inventing one', () => {
    connect(WALLETS.funder);
    open({ order: '2', role: 'funder' });
    expect(screen.getByText(/Any wallet that is not the buyer/i)).toBeTruthy();
  });
});

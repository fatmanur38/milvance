// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WalletState } from '@/lib/wallet/controller';

import { WalletChip, WalletNotice } from './wallet-chip';

const wallet = vi.hoisted(() => ({ state: { phase: 'disconnected' } as WalletState }));
vi.mock('@/lib/wallet/provider', () => ({
  useWallet: () => ({
    controller: { connect: vi.fn(), disconnect: vi.fn(), refresh: vi.fn() },
    state: wallet.state,
  }),
}));

const ADDRESS = 'GCKFEDBA24UY7Q3KTIJC7HDUMCJPBDAJ5NGDLGKMLFMWMSEH47VXEKHW';

beforeEach(() => {
  wallet.state = { phase: 'disconnected' };
});

describe('wallet states', () => {
  it('invites a disconnected visitor to connect, and says keys stay with them', () => {
    render(<WalletNotice />);
    expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeTruthy();
    expect(screen.getByText(/never holds your keys/)).toBeTruthy();
  });

  it('blocks on the wrong network with a clear explanation', () => {
    wallet.state = { phase: 'wrong-network', address: ADDRESS };
    render(
      <>
        <WalletChip />
        <WalletNotice />
      </>,
    );
    expect(screen.getByText('Wrong network')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/Nothing can be signed until it matches/);
  });

  it('explains a missing trustline without blocking USDC-free actions', () => {
    wallet.state = { phase: 'trustline-required', address: ADDRESS, trustline: 'missing' };
    render(<WalletNotice />);
    expect(
      screen.getByText(/can still review and sign actions that do not move money/),
    ).toBeTruthy();
  });

  it('shows the connected address in short form', () => {
    wallet.state = { phase: 'connected', address: ADDRESS, trustline: 'present' };
    render(<WalletChip />);
    expect(screen.getByText('GCKF…EKHW').getAttribute('title')).toBe(ADDRESS);
    expect(screen.getByText('Testnet')).toBeTruthy();
  });
});

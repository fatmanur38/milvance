// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WalletState } from '@/lib/wallet/controller';
import { milestone, order, WALLETS } from '@/lib/test/fixtures';
import { testnetDeployment } from '@/lib/wallet/config';
import { renderWithData } from '@/test/render';

import { TradeLab } from './trade-lab';

const wallet = vi.hoisted(() => ({ state: { phase: 'disconnected' } as WalletState }));
vi.mock('@/lib/wallet/provider', () => ({
  useWallet: () => ({ controller: { connect: vi.fn(), signRaw: vi.fn() }, state: wallet.state }),
}));

function connect(address: string) {
  wallet.state = { phase: 'connected', address, trustline: 'present' };
}

const trade = order({
  orderId: '2',
  status: 'ACTIVE',
  milestones: [milestone({ status: 'FUNDED' })],
});

function show(orders: ReturnType<typeof order>[] = []) {
  return renderWithData(<TradeLab />, {
    orders: { participant: wallet.state.address ?? '', orders },
  });
}

beforeEach(() => {
  wallet.state = { phase: 'disconnected' };
  window.localStorage.clear();
});

describe('Trade Lab', () => {
  it('says clearly that this is Testnet, with the real contract', () => {
    show();
    expect(screen.getByText(/Stellar Testnet only/i)).toBeTruthy();
    expect(screen.getByText(/There is no simulated mode/i)).toBeTruthy();
    expect(
      screen.getByText(testnetDeployment.contractId.slice(0, 6), { exact: false }),
    ).toBeTruthy();
  });

  it('offers a fast task and a cross-border trade', () => {
    show();
    expect(screen.getByRole('button', { name: /Review my landing page/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Cross-border manufacturing/i })).toBeTruthy();
  });

  it('presents a template as suggestions, never as chain state', () => {
    show();
    expect(screen.getByText(/signs nothing and writes nothing to Stellar/i)).toBeTruthy();
  });

  it('explains financing without merging the two pools', () => {
    show();
    const text = screen.getByText(/Financing example/i).textContent ?? '';
    expect(text).toMatch(/straight to the supplier/i);
    expect(text).toMatch(/never moves until\s+settlement/i);
  });

  it('asks for a wallet before creating anything', () => {
    show();
    expect(screen.getByText(/Connect your wallet first/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Review in wallet/i })).toBeNull();
  });

  it('lists the trades the connected wallet is part of, with its role', () => {
    connect(WALLETS.supplier);
    show([trade]);
    const entry = screen.getByText(/Trade #2/).closest('li');
    expect(entry).not.toBeNull();
    expect(entry?.textContent).toMatch(/Supplier/);
    expect(entry?.textContent).toMatch(/In production/);
    expect(screen.getByRole('link', { name: /Open run/i })).toBeTruthy();
  });

  it('suggests the parties from the most recent trade, not the oldest', () => {
    connect(WALLETS.buyer);
    const oldest = order({ orderId: '1', supplier: WALLETS.outsider });
    const latest = order({ orderId: '12', supplier: WALLETS.supplier });
    show([oldest, latest]);

    const supplierField = screen
      .getByText('Supplier address')
      .closest('label')
      ?.querySelector('input');
    expect(supplierField?.value).toBe(WALLETS.supplier);
  });

  it('shows the real create-order form once a wallet is connected', () => {
    connect(WALLETS.buyer);
    show([]);
    // The same wallet-signed component the workspace uses.
    expect(screen.getByText(/Create an order/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Review in wallet/i })).toBeTruthy();
  });

  it('asks for consent to be counted, and promises nothing more', () => {
    connect(WALLETS.buyer);
    show([]);
    expect(screen.getByText(/no name, no contact/i)).toBeTruthy();
    expect(screen.getByText(/Consent is not evidence of use/i)).toBeTruthy();
  });
});

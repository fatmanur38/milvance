// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalPaymentsPanel } from './local-payments-panel';

const fixture = vi.hoisted(() => {
  const address = `G${'A'.repeat(55)}`;
  const session = { token: 'test-session', account: address, expiresAt: 4_000_000_000 };
  const pending = {
    id: 'sep_test_deposit',
    kind: 'deposit',
    status: 'pending_user_transfer_start',
    instructions: {},
  };
  const processing = { ...pending, status: 'pending_anchor' };
  return {
    address,
    session,
    pending,
    processing,
    discover: vi.fn(),
    beginAuth: vi.fn(),
    completeAuth: vi.fn(),
    getCustomerStatus: vi.fn(),
    getQuote: vi.fn(),
    deposit: vi.fn(),
    getTransaction: vi.fn(),
    simulateBankTransfer: vi.fn(),
    pollTransfer: vi.fn(),
    signRaw: vi.fn(),
    refresh: vi.fn(),
  };
});

vi.mock('@/lib/anchor/client', () => ({
  anchorProvider: fixture,
  mockAnchorDriver: { simulateBankTransfer: fixture.simulateBankTransfer },
}));
vi.mock('@/lib/anchor/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/anchor/config')>()),
  mockAnchorEnabled: true,
}));
vi.mock('@/lib/anchor/session', () => ({
  activeSession: () => fixture.session,
  storeSession: vi.fn(),
  clearSession: vi.fn(),
}));
vi.mock('@/lib/anchor/flow', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/anchor/flow')>()),
  pollTransfer: fixture.pollTransfer,
}));
vi.mock('@/lib/wallet/provider', () => ({
  useWallet: () => ({
    controller: { signRaw: fixture.signRaw, refresh: fixture.refresh },
    state: { phase: 'connected', address: fixture.address, trustline: 'present' },
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  fixture.discover.mockResolvedValue({});
  fixture.beginAuth.mockResolvedValue({ transactionXdr: 'challenge' });
  fixture.signRaw.mockResolvedValue('signed-challenge');
  fixture.completeAuth.mockResolvedValue(fixture.session);
  fixture.getCustomerStatus.mockResolvedValue({ status: 'ACCEPTED', missingFields: [] });
  fixture.getQuote.mockResolvedValue({
    id: 'quote-1',
    sellAsset: 'iso4217:TRY',
    sellAmount: '1000',
    buyAsset: 'stellar:USDC:TEST',
    buyAmount: '20',
    price: '50',
    totalPrice: '50',
    expiresAt: Math.floor(Date.now() / 1000) + 900,
    feeDetails: [],
  });
  fixture.deposit.mockResolvedValue(fixture.pending);
  fixture.simulateBankTransfer.mockResolvedValue(undefined);
  fixture.pollTransfer.mockImplementation(async (_read, _id, _session, _capabilities, options) => {
    options.onUpdate(fixture.processing);
    return fixture.processing;
  });
  fixture.getTransaction.mockResolvedValue(fixture.processing);
});

describe('sandbox bank simulation', () => {
  it('does not offer a second simulation while the provider is processing', async () => {
    render(<LocalPaymentsPanel />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Sign in to the local-payment provider' }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Get rate' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start deposit' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Simulate the bank transfer' }));
    await waitFor(() => expect(fixture.simulateBankTransfer).toHaveBeenCalledTimes(1));
    await screen.findByText(/The provider is processing this transfer/);

    expect(screen.queryByRole('button', { name: 'Simulate the bank transfer' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check transfer status' }));
    await waitFor(() =>
      expect(fixture.getTransaction).toHaveBeenCalledWith(fixture.pending.id, fixture.session, {}),
    );
    expect(fixture.simulateBankTransfer).toHaveBeenCalledTimes(1);
  });

  it('looks up a previous transfer without sending the bank simulation again', async () => {
    render(<LocalPaymentsPanel />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Sign in to the local-payment provider' }),
    );
    fireEvent.click(await screen.findByText('Check an existing transfer'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Provider reference' }), {
      target: { value: fixture.pending.id },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check transfer' }));

    await screen.findByText(/The provider is processing this transfer/);
    expect(fixture.getTransaction).toHaveBeenCalledWith(fixture.pending.id, fixture.session, {});
    expect(fixture.simulateBankTransfer).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Simulate the bank transfer' })).toBeNull();
  });
});

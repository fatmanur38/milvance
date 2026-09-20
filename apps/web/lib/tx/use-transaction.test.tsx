// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WalletState } from '../wallet/controller';

const mocks = vi.hoisted(() => ({
  wallet: { phase: 'disconnected' } as WalletState,
  run: vi.fn(),
  indexerStatus: vi.fn(),
}));

vi.mock('../wallet/provider', () => ({
  useWallet: () => ({ controller: { signRaw: vi.fn() }, state: mocks.wallet }),
}));
vi.mock('./runner', () => ({ runContractCall: mocks.run }));
vi.mock('../api/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/queries')>();
  return { ...actual, api: { ...actual.api, indexerStatus: mocks.indexerStatus } };
});

import { useContractTransaction } from './use-transaction';

const ADDRESS = 'GCKFEDBA24UY7Q3KTIJC7HDUMCJPBDAJ5NGDLGKMLFMWMSEH47VXEKHW';

function setup() {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { ...renderHook(() => useContractTransaction(), { wrapper }), invalidate };
}

beforeEach(() => {
  mocks.run.mockReset();
  mocks.indexerStatus.mockReset();
  mocks.wallet = { phase: 'connected', address: ADDRESS, trustline: 'present' };
});

describe('one wallet-signed action, end to end', () => {
  it('refuses before building anything when no wallet is connected', async () => {
    mocks.wallet = { phase: 'disconnected' };
    const { result } = setup();
    await act(async () => {
      await result.current.run({ kind: 'accept-order', orderId: '1' });
    });
    expect(result.current.state.stage).toBe('failed');
    expect(result.current.state.failure?.kind).toBe('not-connected');
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('refuses on the wrong network', async () => {
    mocks.wallet = { phase: 'wrong-network', address: ADDRESS };
    const { result } = setup();
    await act(async () => {
      await result.current.run({ kind: 'accept-order', orderId: '1' });
    });
    expect(result.current.state.failure?.kind).toBe('wrong-network');
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('reports a declined signature as a rejection', async () => {
    mocks.run.mockImplementation(async (_call, deps) => {
      deps.onStage('awaiting-signature');
      throw new Error('The user rejected this request');
    });
    const { result } = setup();
    await act(async () => {
      await result.current.run({ kind: 'settle-milestone', milestoneId: '1' });
    });
    expect(result.current.state.failure?.kind).toBe('rejected');
  });

  it('waits for the indexer after confirmation, then re-reads chain data', async () => {
    mocks.run.mockResolvedValue({ hash: 'f'.repeat(64), ledger: 4_770_000 });
    mocks.indexerStatus.mockResolvedValue({ scannedThroughLedger: '4770000' });
    const { result, invalidate } = setup();
    await act(async () => {
      await result.current.run({ kind: 'accept-order', orderId: '1' });
    });
    await waitFor(() => expect(result.current.state.stage).toBe('synced'));
    expect(result.current.state.hash).toBe('f'.repeat(64));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['chain'] });
  });
});

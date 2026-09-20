// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { testnetDeployment } from './config';

/**
 * Proves the switch reaches the screen on its own. The controller tests cover
 * the state change; this covers the wiring that makes it happen without the
 * user reconnecting, which is what a person swapping between roles relies on.
 */
const wallet = vi.hoisted(() => ({
  address: 'GBUYER',
  passphrase: 'Test SDF Network ; September 2015',
  disconnected: false,
}));

vi.mock('./freighter', () => ({
  FreighterWallet: class {
    async connect(): Promise<string> {
      return wallet.address;
    }
    async restore(): Promise<string> {
      return wallet.address;
    }
    async disconnect(): Promise<void> {
      wallet.disconnected = true;
    }
    async networkPassphrase(): Promise<string> {
      return wallet.passphrase;
    }
    async currentAddress(): Promise<string> {
      return wallet.address;
    }
    async signTransaction(xdr: string): Promise<string> {
      return xdr;
    }
  },
}));
vi.mock('./trustline', () => ({
  HorizonTrustline: class {
    async check(): Promise<'present'> {
      return 'present';
    }
  },
}));
vi.mock('./contract', () => ({ MilvanceContract: class {} }));

const { WalletProvider, useWallet } = await import('./provider');

function ConnectedAddress(): React.ReactElement {
  const { state } = useWallet();
  return <p>account: {state.address ?? 'none'}</p>;
}

describe('wallet provider', () => {
  beforeEach(() => {
    wallet.address = 'GBUYER';
    wallet.passphrase = testnetDeployment.networkPassphrase;
    window.localStorage.setItem('milvance:wallet-address', 'GBUYER');
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
  });

  const tick = async (ms: number): Promise<void> => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  it('shows the account Freighter switched to, with no reconnect', async () => {
    render(
      <WalletProvider>
        <ConnectedAddress />
      </WalletProvider>,
    );
    await tick(0);
    expect(screen.getByText(/account: GBUYER/)).toBeTruthy();

    wallet.address = 'GSUPPLIER';
    await tick(3000);

    expect(screen.getByText(/account: GSUPPLIER/)).toBeTruthy();
  });

  it('picks the switch up as soon as the tab is looked at again', async () => {
    render(
      <WalletProvider>
        <ConnectedAddress />
      </WalletProvider>,
    );
    await tick(0);

    wallet.address = 'GFUNDER';
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(screen.getByText(/account: GFUNDER/)).toBeTruthy();
  });

  it('stops polling once unmounted', async () => {
    const { unmount } = render(
      <WalletProvider>
        <ConnectedAddress />
      </WalletProvider>,
    );
    await tick(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

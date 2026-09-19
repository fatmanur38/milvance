import { describe, expect, it, vi } from 'vitest';
import { FreighterWallet } from './freighter';
import { testnetDeployment } from './config';

const mockKit = vi.hoisted(() => {
  let selected = false;
  return {
    init: vi.fn(() => {
      selected = true;
    }),
    fetchAddress: vi.fn(async () => {
      if (!selected) throw new Error('No selected wallet');
      return { address: 'GBUYER' };
    }),
    getNetwork: vi.fn(async () => ({ networkPassphrase: 'Test SDF Network ; September 2015' })),
    signTransaction: vi.fn(async () => ({ signedTxXdr: 'signed', signerAddress: 'GBUYER' })),
    disconnect: vi.fn(async () => {
      selected = false;
    }),
  };
});

vi.mock('@creit.tech/stellar-wallets-kit/sdk', () => ({ StellarWalletsKit: mockKit }));
vi.mock('@creit.tech/stellar-wallets-kit/modules/freighter', () => ({
  FREIGHTER_ID: 'freighter',
  FreighterModule: class {},
}));
vi.mock('@creit.tech/stellar-wallets-kit/types', () => ({
  Networks: { TESTNET: 'Test SDF Network ; September 2015' },
}));

describe('Freighter Wallets Kit adapter', () => {
  it('reinitializes the selected module after disconnect and reconnect', async () => {
    const wallet = new FreighterWallet();
    expect(await wallet.connect()).toBe('GBUYER');
    await wallet.disconnect();
    expect(await wallet.connect()).toBe('GBUYER');
    expect(mockKit.init).toHaveBeenCalledTimes(2);
  });

  it('checks the actual extension network immediately before signing', async () => {
    const wallet = new FreighterWallet();
    mockKit.getNetwork.mockResolvedValueOnce({
      networkPassphrase: 'Public Global Stellar Network ; September 2015',
    });
    await expect(wallet.signTransaction('xdr', 'GBUYER')).rejects.toThrow(
      'Switch Freighter to Stellar Testnet',
    );
    expect(mockKit.signTransaction).not.toHaveBeenCalled();
    await expect(wallet.signTransaction('xdr', 'GBUYER')).resolves.toBe('signed');
    expect(mockKit.signTransaction).toHaveBeenCalledWith('xdr', {
      address: 'GBUYER',
      networkPassphrase: testnetDeployment.networkPassphrase,
    });
  });
});

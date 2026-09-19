'use client';

import type { WalletPort } from './ports';
import { testnetDeployment } from './config';

/** This adapter is the only place that loads the browser extension SDK. */
export class FreighterWallet implements WalletPort {
  private initialized = false;

  private async kit() {
    const [{ StellarWalletsKit }, { FreighterModule, FREIGHTER_ID }, { Networks }] =
      await Promise.all([
        import('@creit.tech/stellar-wallets-kit/sdk'),
        import('@creit.tech/stellar-wallets-kit/modules/freighter'),
        import('@creit.tech/stellar-wallets-kit/types'),
      ]);
    if (!this.initialized) {
      StellarWalletsKit.init({
        modules: [new FreighterModule()],
        selectedWalletId: FREIGHTER_ID,
        network: Networks.TESTNET,
      });
      this.initialized = true;
    }
    return StellarWalletsKit;
  }

  async connect(): Promise<string> {
    const kit = await this.kit();
    return (await kit.fetchAddress()).address;
  }

  async restore(): Promise<string> {
    // A saved public address is only a hint. Freighter must still authorize access.
    return this.connect();
  }

  async disconnect(): Promise<void> {
    await (await this.kit()).disconnect();
    // Kit clears its selected module on disconnect; reinitialize before reconnect.
    this.initialized = false;
  }

  async networkPassphrase(): Promise<string> {
    return (await (await this.kit()).getNetwork()).networkPassphrase;
  }

  async currentAddress(): Promise<string> {
    return (await (await this.kit()).fetchAddress()).address;
  }

  async signTransaction(xdr: string, address: string): Promise<string> {
    const kit = await this.kit();
    if ((await kit.getNetwork()).networkPassphrase !== testnetDeployment.networkPassphrase) {
      throw new Error('Switch Freighter to Stellar Testnet before signing.');
    }
    if ((await kit.fetchAddress()).address !== address) {
      throw new Error('Freighter account changed before signing. Reconnect and try again.');
    }
    const result = await kit.signTransaction(xdr, {
      address,
      networkPassphrase: testnetDeployment.networkPassphrase,
    });
    if (result.signerAddress && result.signerAddress !== address) {
      throw new Error('Freighter signed with a different account. Reconnect and try again.');
    }
    if (!result.signedTxXdr) throw new Error('Freighter did not return a signed transaction.');
    return result.signedTxXdr;
  }
}

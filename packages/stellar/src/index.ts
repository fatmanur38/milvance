/**
 * @milvance/stellar — network configuration and read-only helpers.
 *
 * PKG-00 scope: constants and URL helpers only.
 *
 * This package must never hold a secret key, build a signed transaction on a
 * server, or act as a custodian. User transactions are authorized in the browser
 * through Stellar Wallets Kit (PKG-06).
 */

export const STELLAR_NETWORKS = {
  testnet: {
    id: 'testnet',
    passphrase: 'Test SDF Network ; September 2015',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    explorerBaseUrl: 'https://stellar.expert/explorer/testnet',
  },
} as const;

export type StellarNetworkId = keyof typeof STELLAR_NETWORKS;
export type StellarNetwork = (typeof STELLAR_NETWORKS)[StellarNetworkId];

/** Testnet USDC issuer used for the hackathon (AGENT.md §21). */
export const USDC_ISSUER_TESTNET = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

export function getNetwork(id: StellarNetworkId): StellarNetwork {
  return STELLAR_NETWORKS[id];
}

export function transactionExplorerUrl(network: StellarNetwork, txHash: string): string {
  return `${network.explorerBaseUrl}/tx/${txHash}`;
}

export function contractExplorerUrl(network: StellarNetwork, contractId: string): string {
  return `${network.explorerBaseUrl}/contract/${contractId}`;
}

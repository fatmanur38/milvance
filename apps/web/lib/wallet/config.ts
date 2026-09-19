import deployment from '../../../../deployments/testnet.json';

/** Public deployment values are read from the committed PKG-05 artifact. */
export const testnetDeployment = deployment;

export const explorerTransaction = (hash: string): string =>
  `https://stellar.expert/explorer/testnet/tx/${encodeURIComponent(hash)}`;

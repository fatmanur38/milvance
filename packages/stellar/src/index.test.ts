import { describe, expect, it } from 'vitest';

import {
  contractExplorerUrl,
  getNetwork,
  transactionExplorerUrl,
  USDC_ISSUER_TESTNET,
} from './index.js';

describe('@milvance/stellar', () => {
  it('pins the testnet network passphrase', () => {
    expect(getNetwork('testnet').passphrase).toBe('Test SDF Network ; September 2015');
  });

  it('pins the hackathon testnet USDC issuer', () => {
    expect(USDC_ISSUER_TESTNET).toMatch(/^G[A-Z0-9]{55}$/);
  });

  it('builds explorer links', () => {
    const network = getNetwork('testnet');
    expect(transactionExplorerUrl(network, 'abc')).toBe(
      'https://stellar.expert/explorer/testnet/tx/abc',
    );
    expect(contractExplorerUrl(network, 'C123')).toBe(
      'https://stellar.expert/explorer/testnet/contract/C123',
    );
  });
});

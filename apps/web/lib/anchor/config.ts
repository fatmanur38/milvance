import { fiatAsset, stellarAsset } from '@milvance/anchor';

import { testnetDeployment } from '../wallet/config';

/**
 * Local-payment configuration, centralized.
 *
 * The home domain is the only Anchor value here. Every endpoint is discovered
 * from its SEP-1 document at runtime, so moving to a production Turkish Anchor
 * is a change to this one string.
 */
export const anchorConfig = {
  homeDomain: process.env.NEXT_PUBLIC_ANCHOR_HOME_DOMAIN ?? 'tr-mock-anchor.fly.dev',
  networkPassphrase: testnetDeployment.networkPassphrase,
  assetCode: 'USDC',
  usdcIssuer: testnetDeployment.usdcIssuer,
  localCurrency: 'TRY',
  /** The sandbox's documented per-transfer deposit band. */
  depositMin: 50,
  depositMax: 3000,
  /** The sandbox's documented withdrawal floor. */
  withdrawMin: 1,
} as const;

export const USDC_ASSET = stellarAsset(anchorConfig.assetCode, anchorConfig.usdcIssuer);
export const TRY_ASSET = fiatAsset(anchorConfig.localCurrency);

/**
 * Whether the hackathon bank-transfer simulator may be used.
 *
 * Defaults to off. The simulator stands in for a bank integration that a real
 * Anchor has and this sandbox does not, so it must never be enabled against a
 * production Anchor.
 */
export const mockAnchorEnabled = process.env.NEXT_PUBLIC_ANCHOR_MOCK_MODE === 'true';

export const explorerTransaction = (hash: string): string =>
  `https://stellar.expert/explorer/testnet/tx/${encodeURIComponent(hash)}`;

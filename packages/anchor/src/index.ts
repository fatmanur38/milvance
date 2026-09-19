/**
 * @milvance/anchor — the local-money edge of Milvance (PKG-07).
 *
 * Milvance settles in Stellar USDC, but a Turkish supplier pays for materials,
 * labour and local logistics in TRY. This package is what turns local money
 * into programmable Stellar liquidity and back again:
 *
 * ```text
 * TRY → Anchor → USDC → protected milestones and funder advances
 * funder advance → USDC → Anchor → TRY → production starts
 * ```
 *
 * All access goes through {@link AnchorProvider}. Hackathon-only simulation is
 * isolated in {@link MockAnchorDevDriver} and is never reachable from the
 * standard SEP path.
 */

export { AnchorError, explain } from './errors.js';
export type { AnchorErrorCode } from './errors.js';

export { parseStellarToml, requireCurrency } from './toml.js';

export type { AnchorProvider, FetchLike } from './provider.js';
export { SepAnchorProvider } from './sep-provider.js';
export type { SepAnchorProviderOptions } from './sep-provider.js';

export { MockAnchorDevDriver } from './mock-driver.js';
export type { MockAnchorDevDriverOptions, SimulateBankTransferInput } from './mock-driver.js';

export * from './types.js';

/** The adapter is implemented as of PKG-07. */
export const ANCHOR_ADAPTER_IMPLEMENTED = true as const;

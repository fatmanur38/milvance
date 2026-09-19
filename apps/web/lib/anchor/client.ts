'use client';

import { MockAnchorDevDriver, SepAnchorProvider } from '@milvance/anchor';

import { anchorConfig, mockAnchorEnabled } from './config';

/**
 * Browser wiring for the Anchor adapter.
 *
 * The Anchor serves permissive CORS, so the browser talks to it directly and no
 * Milvance server ever sees the user's SEP-10 token. That keeps the
 * non-custodial boundary intact by construction rather than by policy.
 */
export const anchorProvider = new SepAnchorProvider({
  fetch: (input, init) => fetch(input, init),
  expectedNetworkPassphrase: anchorConfig.networkPassphrase,
});

/**
 * Development-only bank-transfer simulator.
 *
 * Disabled unless the build explicitly opts in. Nothing in the standard
 * deposit or withdrawal path calls it.
 */
export const mockAnchorDriver = new MockAnchorDevDriver({
  fetch: (input, init) => fetch(input, init),
  enabled: mockAnchorEnabled,
});

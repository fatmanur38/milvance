/**
 * The Anchor adapter boundary (AGENT.md §21).
 *
 * Everything Milvance does with local money goes through this interface. No
 * domain code may import a SEP endpoint, a hackathon-only route, or a provider
 * implementation directly — swapping the mock Anchor for a production one must
 * be a wiring change, not a rewrite.
 *
 * The interface is deliberately **stateless**: a session is passed to every
 * call that needs one rather than held on the provider. A provider instance
 * that remembered a session would make it easy to leak one user's bearer token
 * into another user's request, and it keeps each token's lifetime visible at
 * the call site.
 */

import type {
  AnchorCapabilities,
  AnchorQuote,
  AnchorSession,
  AnchorTransaction,
  AuthChallenge,
  BeginAuthInput,
  CustomerStatus,
  DepositInput,
  QuoteInput,
  SignedChallengeInput,
  WithdrawInput,
} from './types.js';

export interface AnchorProvider {
  /** SEP-1: read and validate the Anchor's published capabilities. */
  discover(homeDomain: string): Promise<AnchorCapabilities>;

  /** SEP-10: fetch a challenge for the **user's wallet** to sign. */
  beginAuth(input: BeginAuthInput): Promise<AuthChallenge>;

  /** SEP-10: exchange the wallet-signed challenge for a session. */
  completeAuth(input: SignedChallengeInput): Promise<AnchorSession>;

  /** SEP-12: where this customer stands with the Anchor. */
  getCustomerStatus(
    session: AnchorSession,
    capabilities: AnchorCapabilities,
  ): Promise<CustomerStatus>;

  /** SEP-38: a firm, expiring quote. Never invent a rate locally. */
  getQuote(input: QuoteInput): Promise<AnchorQuote>;

  /** SEP-6: start a local-currency deposit that lands as Stellar USDC. */
  deposit(input: DepositInput): Promise<AnchorTransaction>;

  /** SEP-6: start a withdrawal that pays out in local currency. */
  withdraw(input: WithdrawInput): Promise<AnchorTransaction>;

  /** SEP-6: poll one transfer. */
  getTransaction(
    id: string,
    session: AnchorSession,
    capabilities: AnchorCapabilities,
  ): Promise<AnchorTransaction>;
}

/** Injected so tests and the browser can supply their own fetch. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

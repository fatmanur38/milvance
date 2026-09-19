/**
 * `MockAnchorDevDriver` — hackathon-only development infrastructure (PKG-07).
 *
 * # Why this file is separate
 *
 * The TR mock Anchor exposes one route that no production Anchor has:
 *
 * ```text
 * POST /sep6/tx/{id}/simulate-bank-transfer
 * ```
 *
 * A real Turkish Anchor learns that TRY arrived from its bank integration. The
 * sandbox needs someone to say so. That is a *development* capability, not a
 * product capability, so it lives here and **nothing in `SepAnchorProvider`
 * imports it**. Delete this file and the standard SEP path still compiles and
 * runs; only the sandbox shortcut disappears.
 *
 * # This does not move real money
 *
 * Calling this simulates a bank credit inside the sandbox. No Turkish bank is
 * involved and no real TRY exists. The *Stellar* leg it triggers is real
 * testnet USDC. Any UI surfacing this must say so plainly.
 */

import { AnchorError } from './errors.js';
import type { FetchLike } from './provider.js';
import type { AnchorCapabilities, AnchorSession } from './types.js';

export interface MockAnchorDevDriverOptions {
  readonly fetch: FetchLike;
  /**
   * Guard against ever shipping the simulation. The driver refuses to act
   * unless the caller states this is a development build.
   */
  readonly enabled: boolean;
}

export interface SimulateBankTransferInput {
  readonly capabilities: AnchorCapabilities;
  readonly session: AnchorSession;
  readonly transactionId: string;
  /** TRY the sandbox should pretend arrived. Defaults to the requested amount. */
  readonly amount?: string;
}

export class MockAnchorDevDriver {
  readonly #fetch: FetchLike;
  readonly #enabled: boolean;

  constructor(options: MockAnchorDevDriverOptions) {
    this.#fetch = options.fetch;
    this.#enabled = options.enabled;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /**
   * Tells the sandbox that the customer's TRY bank transfer arrived.
   *
   * Stands in for a bank integration webhook. Against a production Anchor this
   * route does not exist and must never be called.
   */
  async simulateBankTransfer(input: SimulateBankTransferInput): Promise<void> {
    if (!this.#enabled) {
      throw new AnchorError(
        'anchor_unavailable',
        'The bank-transfer simulator is a development-only tool and is disabled in this build.',
      );
    }

    const base = input.capabilities.transferServer.replace(/\/+$/, '');
    const url = `${base}/tx/${encodeURIComponent(input.transactionId)}/simulate-bank-transfer`;

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.session.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input.amount === undefined ? {} : { amount: input.amount }),
      });
    } catch {
      throw new AnchorError('anchor_unavailable', 'The sandbox simulator is unreachable.');
    }

    if (!response.ok) {
      throw new AnchorError(
        'deposit_failed',
        `The sandbox simulator rejected the request (HTTP ${response.status}).`,
        response.status,
      );
    }
  }
}

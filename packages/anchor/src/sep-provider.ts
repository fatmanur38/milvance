/**
 * `SepAnchorProvider` — a real SEP-1/10/12/38/6 client (PKG-07).
 *
 * This implementation knows only the standard SEP surface discovered from the
 * Anchor's `stellar.toml`. It contains **no** hackathon-only route: the mock
 * bank-transfer simulation lives in `MockAnchorDevDriver` and nothing here
 * imports it. That is what keeps the same code usable against a production
 * Turkish Anchor.
 *
 * Token discipline: the session JWT is sent only as an `Authorization` header,
 * is never placed in a URL or an error message, and is never logged.
 */

import { AnchorError } from './errors.js';
import type { AnchorErrorCode } from './errors.js';
import type { AnchorProvider, FetchLike } from './provider.js';
import { parseStellarToml } from './toml.js';
import type {
  AnchorCapabilities,
  AnchorInstruction,
  AnchorQuote,
  AnchorSession,
  AnchorTransaction,
  AnchorTransactionKind,
  AnchorTransactionStatus,
  AuthChallenge,
  BeginAuthInput,
  CustomerStatus,
  CustomerStatusValue,
  DepositInput,
  QuoteFeeDetail,
  QuoteInput,
  SignedChallengeInput,
  WithdrawInput,
} from './types.js';

export interface SepAnchorProviderOptions {
  readonly fetch: FetchLike;
  /** Rejects an Anchor serving a different network. */
  readonly expectedNetworkPassphrase?: string;
  /** Injected for deterministic expiry handling in tests. */
  readonly now?: () => number;
}

interface JsonRequest {
  readonly url: string;
  readonly method?: 'GET' | 'POST' | 'PUT';
  readonly session?: AnchorSession;
  readonly body?: unknown;
  readonly failureCode: AnchorErrorCode;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export class SepAnchorProvider implements AnchorProvider {
  readonly #fetch: FetchLike;
  readonly #expectedNetworkPassphrase: string | undefined;
  readonly #now: () => number;

  constructor(options: SepAnchorProviderOptions) {
    this.#fetch = options.fetch;
    this.#expectedNetworkPassphrase = options.expectedNetworkPassphrase;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  // -------------------------------------------------------------------------
  // SEP-1
  // -------------------------------------------------------------------------

  async discover(homeDomain: string): Promise<AnchorCapabilities> {
    const url = `https://${homeDomain.replace(/^https?:\/\//, '')}/.well-known/stellar.toml`;

    let response: Response;
    try {
      response = await this.#fetch(url);
    } catch {
      throw new AnchorError('anchor_unavailable', `Could not reach ${homeDomain}.`);
    }
    if (!response.ok) {
      throw new AnchorError(
        'discovery_failed',
        `${homeDomain} did not serve a usable configuration.`,
        response.status,
      );
    }

    return parseStellarToml(await response.text(), homeDomain, this.#expectedNetworkPassphrase);
  }

  // -------------------------------------------------------------------------
  // SEP-10
  // -------------------------------------------------------------------------

  async beginAuth(input: BeginAuthInput): Promise<AuthChallenge> {
    const params = new URLSearchParams({
      account: input.account,
      home_domain: input.capabilities.homeDomain,
    });
    if (input.memo !== undefined) params.set('memo', input.memo);

    const payload = await this.#json({
      url: `${input.capabilities.webAuthEndpoint}?${params.toString()}`,
      failureCode: 'auth_failed',
    });

    const transactionXdr = asString(payload['transaction']);
    const networkPassphrase = asString(payload['network_passphrase']);
    if (!transactionXdr || !networkPassphrase) {
      throw new AnchorError('auth_failed', 'The provider returned an unusable sign-in challenge.');
    }
    if (
      this.#expectedNetworkPassphrase !== undefined &&
      networkPassphrase !== this.#expectedNetworkPassphrase
    ) {
      throw new AnchorError(
        'network_mismatch',
        'The sign-in challenge targets a different Stellar network.',
      );
    }

    return { transactionXdr, networkPassphrase };
  }

  async completeAuth(input: SignedChallengeInput): Promise<AnchorSession> {
    const payload = await this.#json({
      url: input.capabilities.webAuthEndpoint,
      method: 'POST',
      body: { transaction: input.signedTransactionXdr },
      failureCode: 'auth_failed',
    });

    const token = asString(payload['token']);
    if (!token) {
      throw new AnchorError('auth_failed', 'The provider did not issue a session.');
    }

    const claims = decodeJwtClaims(token);
    const account = claims.sub ?? '';
    // Treat a token with no expiry as short-lived rather than eternal.
    const expiresAt = claims.exp ?? this.#now() + 15 * 60;

    return { token, account, expiresAt };
  }

  // -------------------------------------------------------------------------
  // SEP-12
  // -------------------------------------------------------------------------

  async getCustomerStatus(
    session: AnchorSession,
    capabilities: AnchorCapabilities,
  ): Promise<CustomerStatus> {
    const params = new URLSearchParams({ account: session.account });
    const payload = await this.#json({
      url: `${joinUrl(capabilities.kycServer, 'customer')}?${params.toString()}`,
      session,
      failureCode: 'customer_not_ready',
    });

    const fields = payload['fields'];
    const missingFields =
      fields !== null && typeof fields === 'object' ? Object.keys(fields as object) : [];

    const status = (asString(payload['status']) ?? 'NEEDS_INFO') as CustomerStatusValue;
    const id = asString(payload['id']);

    return id === undefined ? { status, missingFields } : { status, id, missingFields };
  }

  /**
   * Submits customer fields.
   *
   * Part of the standard SEP-12 surface, not a mock-only route. The sandbox
   * accepts any payload; a production Anchor would demand real fields, which is
   * why callers pass them rather than this method inventing them.
   */
  async putCustomer(
    session: AnchorSession,
    capabilities: AnchorCapabilities,
    fields: Readonly<Record<string, string>> = {},
  ): Promise<CustomerStatus> {
    await this.#json({
      url: joinUrl(capabilities.kycServer, 'customer'),
      method: 'PUT',
      session,
      body: { account: session.account, ...fields },
      failureCode: 'customer_not_ready',
    });
    return this.getCustomerStatus(session, capabilities);
  }

  // -------------------------------------------------------------------------
  // SEP-38
  // -------------------------------------------------------------------------

  async getQuote(input: QuoteInput): Promise<AnchorQuote> {
    if ((input.sellAmount === undefined) === (input.buyAmount === undefined)) {
      throw new AnchorError(
        'quote_failed',
        'A quote needs exactly one of an amount to sell or an amount to buy.',
      );
    }

    const body: Record<string, string> = {
      sell_asset: input.sellAsset,
      buy_asset: input.buyAsset,
      context: input.context ?? 'sep6',
    };
    if (input.sellAmount !== undefined) body['sell_amount'] = input.sellAmount;
    if (input.buyAmount !== undefined) body['buy_amount'] = input.buyAmount;
    if (input.sellDeliveryMethod !== undefined) {
      body['sell_delivery_method'] = input.sellDeliveryMethod;
    }
    if (input.buyDeliveryMethod !== undefined) {
      body['buy_delivery_method'] = input.buyDeliveryMethod;
    }

    const payload = await this.#json({
      url: joinUrl(input.capabilities.quoteServer, 'quote'),
      method: 'POST',
      session: input.session,
      body,
      failureCode: 'quote_failed',
    });

    const id = asString(payload['id']);
    const expiresAtRaw = asString(payload['expires_at']);
    if (!id || !expiresAtRaw) {
      throw new AnchorError('quote_failed', 'The provider returned an unusable exchange rate.');
    }

    const fee = payload['fee'];
    const feeRecord =
      fee !== null && typeof fee === 'object' ? (fee as Record<string, unknown>) : {};
    const rawDetails = Array.isArray(feeRecord['details']) ? feeRecord['details'] : [];
    const feeDetails: QuoteFeeDetail[] = rawDetails.map((entry) => {
      const detail = entry as Record<string, unknown>;
      const description = asString(detail['description']);
      const base = {
        name: asString(detail['name']) ?? 'fee',
        amount: asString(detail['amount']) ?? '0',
      };
      return description === undefined ? base : { ...base, description };
    });

    const quote: AnchorQuote = {
      id,
      sellAsset: asString(payload['sell_asset']) ?? input.sellAsset,
      sellAmount: asString(payload['sell_amount']) ?? input.sellAmount ?? '0',
      buyAsset: asString(payload['buy_asset']) ?? input.buyAsset,
      buyAmount: asString(payload['buy_amount']) ?? input.buyAmount ?? '0',
      price: asString(payload['price']) ?? '0',
      totalPrice: asString(payload['total_price']) ?? asString(payload['price']) ?? '0',
      expiresAt: Math.floor(new Date(expiresAtRaw).getTime() / 1000),
      feeDetails,
    };

    const feeTotal = asString(feeRecord['total']);
    const feeAsset = asString(feeRecord['asset']);
    return {
      ...quote,
      ...(feeTotal === undefined ? {} : { feeTotal }),
      ...(feeAsset === undefined ? {} : { feeAsset }),
    };
  }

  // -------------------------------------------------------------------------
  // SEP-6
  // -------------------------------------------------------------------------

  async deposit(input: DepositInput): Promise<AnchorTransaction> {
    const params = new URLSearchParams({
      account: input.destinationAccount,
      type: input.fundingMethod ?? 'bank_account',
    });
    if (input.amount !== undefined) params.set('amount', input.amount);
    if (input.quoteId !== undefined) params.set('quote_id', input.quoteId);

    // `deposit-exchange` is the endpoint that honours an off-chain source asset
    // and a firm quote; plain `deposit` cannot express a TRY-priced ramp.
    //
    // The two endpoints name the on-chain asset differently: `deposit` takes a
    // bare `asset_code`, while `deposit-exchange` takes `destination_asset` as
    // the code and `source_asset` in SEP-38 form (`iso4217:TRY`). Verified
    // against the live anchor.
    const endpoint = input.sourceAsset === undefined ? 'deposit' : 'deposit-exchange';
    if (input.sourceAsset === undefined) {
      params.set('asset_code', input.assetCode);
    } else {
      params.set('destination_asset', input.assetCode);
      params.set('source_asset', input.sourceAsset);
    }

    const payload = await this.#json({
      url: `${joinUrl(input.capabilities.transferServer, endpoint)}?${params.toString()}`,
      session: input.session,
      failureCode: 'deposit_failed',
    });

    return toTransaction(payload, 'deposit');
  }

  async withdraw(input: WithdrawInput): Promise<AnchorTransaction> {
    const params = new URLSearchParams({
      type: input.fundingMethod ?? 'bank_account',
      account: input.sourceAccount,
    });
    if (input.amount !== undefined) params.set('amount', input.amount);
    if (input.quoteId !== undefined) params.set('quote_id', input.quoteId);

    // Mirror image of deposit: `withdraw` takes `asset_code`, while
    // `withdraw-exchange` takes `source_asset` as the code and
    // `destination_asset` in SEP-38 form.
    const endpoint = input.destinationAsset === undefined ? 'withdraw' : 'withdraw-exchange';
    if (input.destinationAsset === undefined) {
      params.set('asset_code', input.assetCode);
    } else {
      params.set('source_asset', input.assetCode);
      params.set('destination_asset', input.destinationAsset);
    }

    const payload = await this.#json({
      url: `${joinUrl(input.capabilities.transferServer, endpoint)}?${params.toString()}`,
      session: input.session,
      failureCode: 'withdraw_failed',
    });

    const transaction = toTransaction(payload, 'withdrawal');

    // Without the destination account and memo the user's USDC cannot be
    // matched to this withdrawal, so refuse to hand back a transfer the caller
    // could try to pay blindly.
    if (!transaction.withdrawAnchorAccount) {
      throw new AnchorError('withdraw_failed', 'The provider did not say where to send the USDC.');
    }
    if (!transaction.withdrawMemo || !transaction.withdrawMemoType) {
      throw new AnchorError('missing_memo', 'The provider did not return a payment reference.');
    }

    return transaction;
  }

  async getTransaction(
    id: string,
    session: AnchorSession,
    capabilities: AnchorCapabilities,
  ): Promise<AnchorTransaction> {
    const params = new URLSearchParams({ id });
    const payload = await this.#json({
      url: `${joinUrl(capabilities.transferServer, 'transaction')}?${params.toString()}`,
      session,
      failureCode: 'transaction_not_found',
    });

    const raw = payload['transaction'];
    if (raw === null || typeof raw !== 'object') {
      throw new AnchorError(
        'transaction_not_found',
        'The provider has no record of this transfer.',
      );
    }
    const record = raw as Record<string, unknown>;
    const kind: AnchorTransactionKind =
      asString(record['kind']) === 'withdrawal' ? 'withdrawal' : 'deposit';
    return toTransaction({ transaction: record }, kind);
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  async #json(request: JsonRequest): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (request.session) {
      if (request.session.expiresAt <= this.#now()) {
        throw new AnchorError('session_expired', 'Your local-payment session expired.');
      }
      // The only place the token appears. Never a URL, never a log line.
      headers['Authorization'] = `Bearer ${request.session.token}`;
    }
    if (request.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    let response: Response;
    try {
      response = await this.#fetch(request.url, {
        method: request.method ?? 'GET',
        headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      });
    } catch {
      throw new AnchorError('anchor_unavailable', 'The local-payment provider is unreachable.');
    }

    if (response.status === 401 || response.status === 403) {
      throw new AnchorError(
        'session_expired',
        'The provider rejected this session. Reconnect your wallet.',
        response.status,
      );
    }
    if (!response.ok) {
      // The body is deliberately not echoed: an Anchor error can repeat the
      // request, and the request carried a bearer token.
      throw new AnchorError(
        request.failureCode,
        `The provider rejected the request (HTTP ${response.status}).`,
        response.status,
      );
    }

    try {
      return (await response.json()) as Record<string, unknown>;
    } catch {
      throw new AnchorError(
        request.failureCode,
        'The provider returned a response Milvance could not read.',
      );
    }
  }
}

/** Reads `sub` and `exp` without verifying: the Anchor verifies its own token. */
function decodeJwtClaims(token: string): { sub?: string; exp?: number } {
  const parts = token.split('.');
  if (parts.length < 2 || parts[1] === undefined) return {};
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
    const json = JSON.parse(
      typeof atob === 'function' ? atob(padded) : Buffer.from(padded, 'base64').toString('utf8'),
    ) as Record<string, unknown>;

    const sub = typeof json['sub'] === 'string' ? json['sub'].split(':')[0] : undefined;
    const exp = typeof json['exp'] === 'number' ? json['exp'] : undefined;
    return {
      ...(sub === undefined ? {} : { sub }),
      ...(exp === undefined ? {} : { exp }),
    };
  } catch {
    return {};
  }
}

function toTransaction(
  payload: Record<string, unknown>,
  kind: AnchorTransactionKind,
): AnchorTransaction {
  const source =
    payload['transaction'] !== null && typeof payload['transaction'] === 'object'
      ? (payload['transaction'] as Record<string, unknown>)
      : payload;

  const rawInstructions = source['instructions'];
  const instructions: Record<string, AnchorInstruction> = {};
  if (rawInstructions !== null && typeof rawInstructions === 'object') {
    for (const [key, value] of Object.entries(rawInstructions as Record<string, unknown>)) {
      if (value !== null && typeof value === 'object') {
        const entry = value as Record<string, unknown>;
        const description = asString(entry['description']);
        instructions[key] = {
          value: asString(entry['value']) ?? '',
          ...(description === undefined ? {} : { description }),
        };
      }
    }
  }

  const id = asString(source['id']) ?? '';
  // An initiation response omits `status`: the transfer exists and is waiting
  // on the user, which is not the same as `incomplete`.
  const status = (asString(source['status']) ??
    'pending_user_transfer_start') as AnchorTransactionStatus;

  const optional = {
    amountIn: asString(source['amount_in']),
    amountOut: asString(source['amount_out']),
    amountFee: asString(source['amount_fee']),
    quoteId: asString(source['quote_id']),
    // A withdrawal initiation reports `account_id`/`memo`/`memo_type`, while
    // the polled transaction object uses the `withdraw_*` names. Accept both so
    // callers never have to care which call produced the record.
    withdrawAnchorAccount:
      asString(source['withdraw_anchor_account']) ?? asString(source['account_id']),
    withdrawMemo: asString(source['withdraw_memo']) ?? asString(source['memo']),
    withdrawMemoType: (asString(source['withdraw_memo_type']) ?? asString(source['memo_type'])) as
      'text' | 'id' | 'hash' | undefined,
    stellarTransactionId: asString(source['stellar_transaction_id']),
    externalTransactionId: asString(source['external_transaction_id']),
    message: asString(source['message']),
    startedAt: asString(source['started_at']),
    completedAt: asString(source['completed_at']),
  };

  const defined = Object.fromEntries(
    Object.entries(optional).filter(([, value]) => value !== undefined),
  );

  return { id, kind, status, instructions, ...defined } as AnchorTransaction;
}

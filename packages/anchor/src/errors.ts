/**
 * Anchor error mapping (PKG-07).
 *
 * Every failure crossing the Anchor boundary becomes an `AnchorError` with a
 * stable code, so the UI can explain what went wrong without parsing prose.
 *
 * `AnchorError` messages are built only from the code, a short caller-supplied
 * description and, where useful, the HTTP status. A bearer token is never part
 * of a message, and raw Anchor response bodies are not embedded, because a
 * SEP-10 JWT can appear in a request echo.
 */
export type AnchorErrorCode =
  | 'discovery_failed'
  | 'missing_capability'
  | 'network_mismatch'
  | 'auth_failed'
  | 'session_expired'
  | 'customer_not_ready'
  | 'quote_failed'
  | 'quote_expired'
  | 'deposit_failed'
  | 'withdraw_failed'
  | 'missing_memo'
  | 'transaction_not_found'
  | 'unsupported_asset'
  | 'anchor_unavailable';

export class AnchorError extends Error {
  readonly code: AnchorErrorCode;
  readonly httpStatus?: number;

  constructor(code: AnchorErrorCode, message: string, httpStatus?: number) {
    super(message);
    this.name = 'AnchorError';
    this.code = code;
    if (httpStatus !== undefined) {
      this.httpStatus = httpStatus;
    }
  }
}

/** Human-facing explanations. Deliberately free of SEP jargon. */
const MESSAGES: Record<AnchorErrorCode, string> = {
  discovery_failed: 'Could not read the local-payment provider’s configuration.',
  missing_capability: 'This provider does not offer the local-payment features Milvance needs.',
  network_mismatch: 'This provider is configured for a different Stellar network.',
  auth_failed: 'The provider did not accept this wallet’s signature.',
  session_expired: 'Your local-payment session expired. Reconnect your wallet to continue.',
  customer_not_ready: 'The provider still needs to verify this customer before transferring.',
  quote_failed: 'Could not get an exchange rate from the provider.',
  quote_expired: 'That exchange rate expired. Request a new one before continuing.',
  deposit_failed: 'The provider could not start this deposit.',
  withdraw_failed: 'The provider could not start this withdrawal.',
  missing_memo:
    'The provider did not return the payment reference required to route this transfer.',
  transaction_not_found: 'The provider has no record of this transfer.',
  unsupported_asset: 'This provider does not support the requested asset.',
  anchor_unavailable: 'The local-payment provider is unreachable right now.',
};

export function explain(code: AnchorErrorCode): string {
  return MESSAGES[code];
}

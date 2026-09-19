/**
 * Exact handling of on-chain quantities.
 *
 * Soroban asset amounts are `i128` and identifiers are `u64`. Both exceed
 * `Number.MAX_SAFE_INTEGER`, so a JavaScript `number` cannot represent them
 * without silently losing precision. AGENT.md is explicit about this: monetary
 * amounts must preserve exact integer semantics, and no floating-point maths may
 * ever touch an asset amount.
 *
 * The rules this module exists to enforce:
 *
 *   - decode to `bigint`,
 *   - store as PostgreSQL `NUMERIC(39, 0)` (via Prisma `Decimal`),
 *   - serialise to JSON as a decimal **string**,
 *   - never `Number(...)`, never `parseFloat`, never arithmetic in `number`.
 *
 * There is deliberately no `toNumber()` helper here. If one existed, someone
 * would eventually call it on a milestone amount.
 */

/** Widest values representable by the chain types we project. */
export const I128_MAX = (1n << 127n) - 1n;
export const I128_MIN = -(1n << 127n);
export const U64_MAX = (1n << 64n) - 1n;

export class AmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmountError';
  }
}

/**
 * Parse a decimal integer string into a `bigint`.
 *
 * Rejects anything that is not a plain base-10 integer — no exponents, no
 * decimal point, no hex, no whitespace-padded surprises. A fractional value
 * reaching this function means a float crept into the pipeline upstream, which
 * is exactly the failure this module is meant to make loud.
 */
export function parseIntegerString(value: string): bigint {
  if (!/^-?\d+$/.test(value)) {
    throw new AmountError(`Not an exact integer: ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}

/** Narrow an unknown decoded value to a `bigint`, accepting the exact forms only. */
export function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'string') {
    return parseIntegerString(value);
  }
  if (typeof value === 'number') {
    // Reaching here means a caller already went through `number`, so precision
    // may already be gone. Refuse rather than launder the loss.
    throw new AmountError(
      `Refusing to read a chain quantity from a JavaScript number (${value}); use bigint or a decimal string`,
    );
  }
  throw new AmountError(`Cannot read a chain quantity from ${typeof value}`);
}

/** Validate an `i128` asset amount. */
export function assertI128(value: bigint, label = 'amount'): bigint {
  if (value < I128_MIN || value > I128_MAX) {
    throw new AmountError(`${label} is outside the i128 range: ${value.toString()}`);
  }
  return value;
}

/** Validate a non-negative `i128`. Asset amounts in this protocol are never negative. */
export function assertNonNegativeI128(value: bigint, label = 'amount'): bigint {
  assertI128(value, label);
  if (value < 0n) {
    throw new AmountError(`${label} must not be negative: ${value.toString()}`);
  }
  return value;
}

/** Validate a `u64` chain identifier or ledger-time value. */
export function assertU64(value: bigint, label = 'value'): bigint {
  if (value < 0n || value > U64_MAX) {
    throw new AmountError(`${label} is outside the u64 range: ${value.toString()}`);
  }
  return value;
}

/**
 * Render a chain quantity for JSON.
 *
 * Always a string. Never a number, at any magnitude — a caller must not have to
 * remember that small amounts are safe and large ones are not.
 */
export function amountToJson(value: bigint | { toString(): string }): string {
  return typeof value === 'bigint' ? value.toString() : value.toString();
}

/**
 * Convert a chain-time value (`u64` unix seconds) into a `Date`.
 *
 * Returns `null` for `0`, which the contract uses as "unset" for optional
 * deadlines that were decoded as a bare zero.
 */
export function ledgerTimeToDate(value: bigint): Date | null {
  assertU64(value, 'ledger time');
  if (value === 0n) {
    return null;
  }
  const millis = value * 1000n;
  if (millis > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AmountError(`Ledger time is too far in the future to represent: ${value.toString()}`);
  }
  return new Date(Number(millis));
}

/**
 * Recursively render a decoded event payload as JSON-safe values.
 *
 * `bigint` becomes a decimal string and `Uint8Array` becomes lower-case hex, so
 * a stored payload round-trips exactly and never depends on `JSON.stringify`
 * throwing on a BigInt.
 */
export function toJsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('hex');
  }
  if (Array.isArray(value)) {
    return value.map(toJsonSafe);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = toJsonSafe(item);
    }
    return out;
  }
  return value;
}

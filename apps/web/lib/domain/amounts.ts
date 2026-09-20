/**
 * Exact USDC amounts.
 *
 * On chain every amount is an i128 count of the asset's smallest unit. Stellar
 * USDC has 7 decimals, so 1 USDC = 10,000,000 units. The API returns these as
 * decimal integer STRINGS precisely so no precision is lost on the way here.
 *
 * Everything below works on `bigint` and strings. There is no `Number(...)`,
 * no `parseFloat`, and no floating-point arithmetic anywhere in this file:
 * `0.1 + 0.2` is not a rounding error we are willing to show next to someone's
 * protected milestone payment.
 */

export const USDC_DECIMALS = 7;
const SCALE = 10n ** BigInt(USDC_DECIMALS);
/** The largest value an i128 can hold. */
const I128_MAX = (1n << 127n) - 1n;

function toUnits(value: string | bigint): bigint {
  if (typeof value === 'bigint') return value;
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`Not an integer amount: ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Render integer units as a human USDC figure, e.g. `100000000000` → `10,000.00`.
 *
 * Always shows at least two decimals and never more than seven; trailing zeros
 * beyond the second are trimmed, so `12,345.6789` stays exact.
 */
export function formatUsdcUnits(value: string | bigint): string {
  const units = toUnits(value);
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const whole = absolute / SCALE;
  const fraction = (absolute % SCALE).toString().padStart(USDC_DECIMALS, '0');
  const trimmed = fraction.replace(/0+$/, '').padEnd(2, '0');
  return `${negative ? '-' : ''}${group(whole.toString())}.${trimmed}`;
}

/** Same as {@link formatUsdcUnits} with the asset code appended. */
export function formatUsdc(value: string | bigint): string {
  return `${formatUsdcUnits(value)} USDC`;
}

export type ParsedAmount = { ok: true; units: bigint } | { ok: false; error: string };

/**
 * Parse what a person typed into integer units.
 *
 * Deliberately strict: plain digits with at most one decimal point and at most
 * seven decimal places. No exponents, no thousands separators, no signs. A
 * rejected entry is better than a silently different amount in a wallet prompt.
 */
export function parseUsdcInput(text: string): ParsedAmount {
  const input = text.trim();
  if (input === '') return { ok: false, error: 'Enter an amount.' };
  const match = /^(\d+)(?:\.(\d+))?$/.exec(input);
  if (match === null) {
    return { ok: false, error: 'Use digits and at most one decimal point, e.g. 1500.50.' };
  }
  const [, whole = '0', fraction = ''] = match;
  if (fraction.length > USDC_DECIMALS) {
    return { ok: false, error: `USDC has at most ${USDC_DECIMALS} decimal places.` };
  }
  const units = BigInt(whole) * SCALE + BigInt(fraction.padEnd(USDC_DECIMALS, '0') || '0');
  if (units <= 0n) return { ok: false, error: 'The amount must be greater than zero.' };
  if (units > I128_MAX) return { ok: false, error: 'That amount is too large.' };
  return { ok: true, units };
}

/** Exact difference of two unit amounts, as a string. */
export function subtractUnits(a: string | bigint, b: string | bigint): string {
  return (toUnits(a) - toUnits(b)).toString();
}

/** Exact comparison helper: -1, 0 or 1. */
export function compareUnits(a: string | bigint, b: string | bigint): -1 | 0 | 1 {
  const left = toUnits(a);
  const right = toUnits(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The funder's margin over principal, as a percentage with two decimals.
 *
 * Computed in integer basis points so the figure shown is exact to 0.01%.
 */
export function marginPercent(principal: string | bigint, repayment: string | bigint): string {
  const p = toUnits(principal);
  const r = toUnits(repayment);
  if (p <= 0n) return '0.00';
  const basisPoints = ((r - p) * 10_000n) / p;
  const sign = basisPoints < 0n ? '-' : '';
  const abs = basisPoints < 0n ? -basisPoints : basisPoints;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

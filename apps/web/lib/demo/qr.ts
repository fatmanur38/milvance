import qrcode from 'qrcode-generator';

/**
 * QR payloads for invite links.
 *
 * A QR code is a link someone points a phone camera at, in a room full of
 * strangers, and it ends up in their camera roll and possibly on a screen
 * behind them. So the payload is deliberately dull: an http(s) URL to this app,
 * carrying only an order id, a role word, an optional milestone id and an
 * optional template id — all of which are already public on chain or are plain
 * navigation.
 *
 * A QR code grants nothing. Scanning one opens a page; what that page lets a
 * person do still comes from their wallet and from MilvanceCore.
 */

/** Query keys an invite QR may carry. Anything else is a bug, not a feature. */
export const QR_ALLOWED_PARAMS = ['order', 'role', 'milestone', 'template'] as const;

/**
 * Words that must never appear in a payload, in any casing.
 *
 * Checked as a last line of defence: the payload builder only emits known keys,
 * so a match here means something upstream started smuggling state into links.
 */
const FORBIDDEN_SUBSTRINGS = [
  'secret',
  'seed',
  'mnemonic',
  'privatekey',
  'private_key',
  'jwt',
  'token',
  'authorization',
  'bearer',
  'password',
  'kyc',
  'iban',
  'apikey',
  'api_key',
  'postgres',
  'database_url',
];

/** A Stellar SECRET key. Public keys start with G and are fine; S keys are not. */
const SECRET_KEY = /\bS[A-Z2-7]{55}\b/;
/** Anything shaped like a JSON Web Token. */
const JWT = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\./;

export type QrSafety = { readonly safe: true } | { readonly safe: false; readonly reason: string };

/**
 * Whether a payload is safe to print on a screen or a badge.
 *
 * Used by the component before rendering and asserted directly in tests, so a
 * future link that carries a session token cannot quietly become a QR code.
 */
export function qrPayloadSafety(payload: string): QrSafety {
  let url: URL;
  try {
    url = new URL(payload);
  } catch {
    return { safe: false, reason: 'A QR payload must be an absolute URL.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { safe: false, reason: 'A QR payload must be an http or https link.' };
  }
  if (url.username !== '' || url.password !== '') {
    return { safe: false, reason: 'A QR payload must not carry credentials.' };
  }
  if (url.hash !== '') {
    return { safe: false, reason: 'A QR payload must not carry a fragment.' };
  }
  for (const key of url.searchParams.keys()) {
    if (!(QR_ALLOWED_PARAMS as readonly string[]).includes(key)) {
      return { safe: false, reason: `A QR payload must not carry "${key}".` };
    }
  }
  const lowered = payload.toLowerCase();
  for (const word of FORBIDDEN_SUBSTRINGS) {
    if (lowered.includes(word))
      return { safe: false, reason: `A QR payload must not mention "${word}".` };
  }
  if (SECRET_KEY.test(payload)) {
    return { safe: false, reason: 'A QR payload must never contain a Stellar secret key.' };
  }
  if (JWT.test(payload)) return { safe: false, reason: 'A QR payload must never contain a token.' };
  return { safe: true };
}

export interface QrMatrix {
  /** Modules per side. */
  readonly size: number;
  /** Row-major dark-module flags. */
  readonly dark: readonly boolean[];
}

/**
 * The QR matrix for a payload, refusing anything that is not safe to publish.
 *
 * Error correction level M: readable when a phone camera catches it at an
 * angle, without making the code denser than a badge can print.
 */
export function qrMatrix(payload: string): QrMatrix {
  const safety = qrPayloadSafety(payload);
  if (!safety.safe) throw new Error(safety.reason);
  const code = qrcode(0, 'M');
  code.addData(payload);
  code.make();
  const size = code.getModuleCount();
  const dark: boolean[] = [];
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      dark.push(code.isDark(row, column));
    }
  }
  return { size, dark };
}

/**
 * An SVG path covering every dark module, for rendering without a canvas.
 *
 * Deterministic: the same payload always produces the same path, which is what
 * makes a printed invite and an on-screen one the same code.
 */
export function qrSvgPath(matrix: QrMatrix): string {
  const parts: string[] = [];
  for (let row = 0; row < matrix.size; row += 1) {
    for (let column = 0; column < matrix.size; column += 1) {
      if (matrix.dark[row * matrix.size + column] === true) {
        parts.push(`M${column} ${row}h1v1h-1z`);
      }
    }
  }
  return parts.join('');
}

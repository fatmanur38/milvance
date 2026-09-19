import type { AnchorSession } from '@milvance/anchor';

/**
 * In-memory SEP-10 session store.
 *
 * The token is a bearer credential for the user's Stellar identity, so it is
 * deliberately held **only** in this module's closure for the life of the tab:
 *
 * - not in `localStorage` or `sessionStorage`, where any script on the origin
 *   could read it and where it would outlive the tab,
 * - not in React state that might be serialized into a server payload,
 * - not sent to any Milvance backend — the browser talks to the Anchor
 *   directly, so no server ever sees it,
 * - never logged, and never placed in an error message.
 *
 * Closing the tab ends the session, which is the behaviour we want.
 */
let current: AnchorSession | null = null;

export function storeSession(session: AnchorSession): void {
  current = session;
}

export function clearSession(): void {
  current = null;
}

/** Returns the live session, or null when absent or expired. */
export function activeSession(
  nowSeconds: number = Math.floor(Date.now() / 1000),
): AnchorSession | null {
  if (!current) return null;
  if (current.expiresAt <= nowSeconds) {
    current = null;
    return null;
  }
  return current;
}

/** Public, non-sensitive view for rendering session state. */
export interface SessionSummary {
  readonly account: string;
  readonly expiresAt: number;
}

export function sessionSummary(session: AnchorSession): SessionSummary {
  return { account: session.account, expiresAt: session.expiresAt };
}

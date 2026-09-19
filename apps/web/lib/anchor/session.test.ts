import { beforeEach, describe, expect, it } from 'vitest';

import { activeSession, clearSession, sessionSummary, storeSession } from './session';

const session = (expiresAt: number) => ({
  token: 'header.payload.signature',
  account: 'GCKFEDBA24UY7Q3KTIJC7HDUMCJPBDAJ5NGDLGKMLFMWMSEH47VXEKHW',
  expiresAt,
});

describe('anchor session store', () => {
  beforeEach(() => clearSession());

  it('returns a live session', () => {
    storeSession(session(2_000));
    expect(activeSession(1_999)?.account).toBe(session(0).account);
  });

  it('drops an expired session instead of returning it', () => {
    storeSession(session(2_000));
    expect(activeSession(2_000)).toBeNull();
    // The expired token is discarded, not merely hidden.
    expect(activeSession(1_000)).toBeNull();
  });

  it('clears on sign-out', () => {
    storeSession(session(9_999));
    clearSession();
    expect(activeSession(1)).toBeNull();
  });

  it('never persists the token to browser storage', () => {
    storeSession(session(9_999));

    const dumped = JSON.stringify({
      local: { ...globalThis.localStorage },
      session: { ...globalThis.sessionStorage },
    });
    expect(dumped).not.toContain('header.payload.signature');
  });

  it('exposes only non-sensitive fields for rendering', () => {
    const summary = sessionSummary(session(5));
    expect(summary).toEqual({ account: session(0).account, expiresAt: 5 });
    expect(JSON.stringify(summary)).not.toContain('signature');
  });
});

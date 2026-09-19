import type { FetchLike } from './provider.js';
import type { AnchorCapabilities, AnchorSession } from './types.js';

export const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
export const TESTNET = 'Test SDF Network ; September 2015';
export const ACCOUNT = 'GCKFEDBA24UY7Q3KTIJC7HDUMCJPBDAJ5NGDLGKMLFMWMSEH47VXEKHW';

/** Mirrors the TR mock Anchor's published SEP-1 document. */
export const TOML = `VERSION="2.7.0"
NETWORK_PASSPHRASE="${TESTNET}"
SIGNING_KEY="GDXYO6FJCNXZEWGXD54GT76FGFYLOLSOGSOJLNQ6WGHCGEQPO7NTE73M"
WEB_AUTH_ENDPOINT="https://tr-mock-anchor.fly.dev/auth"
TRANSFER_SERVER="https://tr-mock-anchor.fly.dev/sep6"
KYC_SERVER="https://tr-mock-anchor.fly.dev/sep12"
ANCHOR_QUOTE_SERVER="https://tr-mock-anchor.fly.dev/sep38"
ACCOUNTS=["GCLCZEQZ2THTEDAOFI66LACNPLY4OBKN7VKLEZFMBIHYKYQOW2W7T3Z6"]

[DOCUMENTATION]
ORG_NAME="TR Mock Anchor (testnet sandbox)"

[[CURRENCIES]]
code="USDC"
issuer="${USDC_ISSUER}"
status="test"
anchor_asset="TRY"
`;

export const CAPABILITIES: AnchorCapabilities = {
  homeDomain: 'tr-mock-anchor.fly.dev',
  networkPassphrase: TESTNET,
  signingKey: 'GDXYO6FJCNXZEWGXD54GT76FGFYLOLSOGSOJLNQ6WGHCGEQPO7NTE73M',
  webAuthEndpoint: 'https://tr-mock-anchor.fly.dev/auth',
  transferServer: 'https://tr-mock-anchor.fly.dev/sep6',
  kycServer: 'https://tr-mock-anchor.fly.dev/sep12',
  quoteServer: 'https://tr-mock-anchor.fly.dev/sep38',
  currencies: [{ code: 'USDC', issuer: USDC_ISSUER, anchorAsset: 'TRY' }],
};

export function session(overrides: Partial<AnchorSession> = {}): AnchorSession {
  return {
    token: 'header.payload.signature',
    account: ACCOUNT,
    expiresAt: 4_000_000_000,
    ...overrides,
  };
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface StubRoute {
  status?: number;
  json?: unknown;
  text?: string;
  throws?: boolean;
}

/** A fetch stub that records every request so tests can assert on transport. */
export function stubFetch(routes: Record<string, StubRoute>): {
  fetch: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];

  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: RecordedCall = { url, method, headers };
    if (typeof init?.body === 'string') call.body = init.body;
    calls.push(call);

    const key = Object.keys(routes).find((pattern) => url.includes(pattern));
    const route = key === undefined ? undefined : routes[key];
    if (!route) {
      return new Response('not stubbed', { status: 404 });
    }
    if (route.throws) throw new Error('network down');
    if (route.text !== undefined) {
      return new Response(route.text, { status: route.status ?? 200 });
    }
    return new Response(JSON.stringify(route.json ?? {}), {
      status: route.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  return { fetch, calls };
}

/** Builds an unsigned JWT-shaped token so claim decoding can be exercised. */
export function fakeJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(claims)}.signature`;
}

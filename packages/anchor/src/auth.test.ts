import { describe, expect, it } from 'vitest';

import { SepAnchorProvider } from './sep-provider.js';
import {
  ACCOUNT,
  CAPABILITIES,
  fakeJwt,
  session,
  stubFetch,
  TESTNET,
} from './fixtures.test-helper.js';

const CHALLENGE_XDR = 'AAAAAgAAAADvh3ipE2+SWNcfeGn/xTFwty5ONJyVth6xjiMSD3fbMg==';

describe('SEP-10 wallet authentication', () => {
  it('requests a challenge for the user’s own account', async () => {
    const { fetch, calls } = stubFetch({
      '/auth': { json: { transaction: CHALLENGE_XDR, network_passphrase: TESTNET } },
    });
    const provider = new SepAnchorProvider({ fetch, expectedNetworkPassphrase: TESTNET });

    const challenge = await provider.beginAuth({ capabilities: CAPABILITIES, account: ACCOUNT });

    expect(challenge.transactionXdr).toBe(CHALLENGE_XDR);
    expect(calls[0]?.url).toContain(`account=${ACCOUNT}`);
    expect(calls[0]?.url).toContain('home_domain=tr-mock-anchor.fly.dev');
    // The challenge is fetched, never signed here: the wallet signs it.
    expect(calls[0]?.method).toBe('GET');
  });

  it('rejects a challenge for a different Stellar network', async () => {
    const { fetch } = stubFetch({
      '/auth': {
        json: {
          transaction: CHALLENGE_XDR,
          network_passphrase: 'Public Global Stellar Network ; September 2015',
        },
      },
    });
    const provider = new SepAnchorProvider({ fetch, expectedNetworkPassphrase: TESTNET });

    await expect(
      provider.beginAuth({ capabilities: CAPABILITIES, account: ACCOUNT }),
    ).rejects.toMatchObject({ code: 'network_mismatch' });
  });

  it('exchanges a wallet-signed challenge for a session', async () => {
    const token = fakeJwt({ sub: ACCOUNT, exp: 4_000_000_000 });
    const { fetch, calls } = stubFetch({ '/auth': { json: { token } } });
    const provider = new SepAnchorProvider({ fetch });

    const result = await provider.completeAuth({
      capabilities: CAPABILITIES,
      signedTransactionXdr: 'signed-xdr',
    });

    expect(result.token).toBe(token);
    expect(result.account).toBe(ACCOUNT);
    expect(result.expiresAt).toBe(4_000_000_000);
    expect(calls[0]?.method).toBe('POST');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ transaction: 'signed-xdr' });
  });

  it('strips a muxed suffix from the token subject', async () => {
    const token = fakeJwt({ sub: `${ACCOUNT}:1234`, exp: 4_000_000_000 });
    const { fetch } = stubFetch({ '/auth': { json: { token } } });
    const provider = new SepAnchorProvider({ fetch });

    const result = await provider.completeAuth({
      capabilities: CAPABILITIES,
      signedTransactionXdr: 'signed',
    });

    expect(result.account).toBe(ACCOUNT);
  });

  it('treats a token without an expiry as short-lived, never eternal', async () => {
    const token = fakeJwt({ sub: ACCOUNT });
    const { fetch } = stubFetch({ '/auth': { json: { token } } });
    const provider = new SepAnchorProvider({ fetch, now: () => 1_000 });

    const result = await provider.completeAuth({
      capabilities: CAPABILITIES,
      signedTransactionXdr: 'signed',
    });

    expect(result.expiresAt).toBe(1_000 + 15 * 60);
  });

  it('surfaces a rejected wallet signature as auth_failed', async () => {
    const { fetch } = stubFetch({ '/auth': { status: 400, json: { error: 'invalid signature' } } });
    const provider = new SepAnchorProvider({ fetch });

    await expect(
      provider.completeAuth({ capabilities: CAPABILITIES, signedTransactionXdr: 'bad' }),
    ).rejects.toMatchObject({ code: 'auth_failed', httpStatus: 400 });
  });

  it('fails when the anchor issues no token', async () => {
    const { fetch } = stubFetch({ '/auth': { json: {} } });
    const provider = new SepAnchorProvider({ fetch });

    await expect(
      provider.completeAuth({ capabilities: CAPABILITIES, signedTransactionXdr: 'signed' }),
    ).rejects.toMatchObject({ code: 'auth_failed' });
  });
});

describe('session handling', () => {
  it('sends the token only as an Authorization header, never in the URL', async () => {
    const { fetch, calls } = stubFetch({
      '/sep12/customer': { json: { status: 'ACCEPTED' } },
    });
    const provider = new SepAnchorProvider({ fetch });
    const active = session({ token: 'super.secret.jwt' });

    await provider.getCustomerStatus(active, CAPABILITIES);

    expect(calls[0]?.headers['Authorization']).toBe('Bearer super.secret.jwt');
    expect(calls[0]?.url).not.toContain('super.secret.jwt');
  });

  it('refuses to use an expired session before making a request', async () => {
    const { fetch, calls } = stubFetch({ '/sep12/customer': { json: { status: 'ACCEPTED' } } });
    const provider = new SepAnchorProvider({ fetch, now: () => 2_000 });
    const expired = session({ expiresAt: 1_999 });

    await expect(provider.getCustomerStatus(expired, CAPABILITIES)).rejects.toMatchObject({
      code: 'session_expired',
    });
    // Nothing left the browser with a dead token attached.
    expect(calls).toHaveLength(0);
  });

  it('maps a 401 from the anchor to session_expired', async () => {
    const { fetch } = stubFetch({ '/sep12/customer': { status: 401, json: {} } });
    const provider = new SepAnchorProvider({ fetch });

    await expect(provider.getCustomerStatus(session(), CAPABILITIES)).rejects.toMatchObject({
      code: 'session_expired',
    });
  });

  it('never echoes the anchor’s error body, which can repeat the token', async () => {
    const { fetch } = stubFetch({
      '/sep12/customer': { status: 500, json: { error: 'Bearer super.secret.jwt rejected' } },
    });
    const provider = new SepAnchorProvider({ fetch });

    await expect(
      provider.getCustomerStatus(session({ token: 'super.secret.jwt' }), CAPABILITIES),
    ).rejects.toSatisfy((error: Error) => !error.message.includes('super.secret.jwt'));
  });
});

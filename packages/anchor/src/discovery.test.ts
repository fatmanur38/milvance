import { describe, expect, it } from 'vitest';

import { AnchorError } from './errors.js';
import { parseStellarToml, requireCurrency } from './toml.js';
import { SepAnchorProvider } from './sep-provider.js';
import { CAPABILITIES, stubFetch, TESTNET, TOML, USDC_ISSUER } from './fixtures.test-helper.js';

describe('SEP-1 discovery', () => {
  it('parses the anchor capabilities Milvance depends on', () => {
    const capabilities = parseStellarToml(TOML, 'tr-mock-anchor.fly.dev', TESTNET);

    expect(capabilities.webAuthEndpoint).toBe('https://tr-mock-anchor.fly.dev/auth');
    expect(capabilities.transferServer).toBe('https://tr-mock-anchor.fly.dev/sep6');
    expect(capabilities.kycServer).toBe('https://tr-mock-anchor.fly.dev/sep12');
    expect(capabilities.quoteServer).toBe('https://tr-mock-anchor.fly.dev/sep38');
    expect(capabilities.signingKey).toMatch(/^G[A-Z0-9]{55}$/);
    expect(capabilities.networkPassphrase).toBe(TESTNET);
  });

  it('reads the TRY-anchored USDC currency', () => {
    const capabilities = parseStellarToml(TOML, 'tr-mock-anchor.fly.dev');

    expect(capabilities.currencies).toHaveLength(1);
    expect(capabilities.currencies[0]).toEqual({
      code: 'USDC',
      issuer: USDC_ISSUER,
      anchorAsset: 'TRY',
    });
  });

  it('ignores keys from other tables such as [DOCUMENTATION]', () => {
    const capabilities = parseStellarToml(TOML, 'tr-mock-anchor.fly.dev');
    expect((capabilities as unknown as Record<string, unknown>)['ORG_NAME']).toBeUndefined();
  });

  it.each([
    ['WEB_AUTH_ENDPOINT', /sign/i],
    ['TRANSFER_SERVER', /TRANSFER_SERVER/],
    ['KYC_SERVER', /KYC_SERVER/],
    ['ANCHOR_QUOTE_SERVER', /ANCHOR_QUOTE_SERVER/],
    ['SIGNING_KEY', /SIGNING_KEY/],
  ])('fails clearly when %s is absent', (key) => {
    const withoutKey = TOML.split('\n')
      .filter((line) => !line.startsWith(`${key}=`))
      .join('\n');

    try {
      parseStellarToml(withoutKey, 'tr-mock-anchor.fly.dev');
      expect.unreachable('a missing capability must be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(AnchorError);
      expect((error as AnchorError).code).toBe('missing_capability');
      expect((error as AnchorError).message).toContain(key);
    }
  });

  it('rejects an anchor serving a different Stellar network', () => {
    try {
      parseStellarToml(
        TOML,
        'tr-mock-anchor.fly.dev',
        'Public Global Stellar Network ; September 2015',
      );
      expect.unreachable('a network mismatch must be rejected');
    } catch (error) {
      expect((error as AnchorError).code).toBe('network_mismatch');
    }
  });

  it('rejects an anchor that does not ramp the approved issuer', () => {
    const capabilities = parseStellarToml(TOML, 'tr-mock-anchor.fly.dev');

    expect(() => requireCurrency(capabilities, 'USDC', USDC_ISSUER)).not.toThrow();
    try {
      requireCurrency(
        capabilities,
        'USDC',
        'GDIFFERENTISSUERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      );
      expect.unreachable('an unknown issuer must be rejected');
    } catch (error) {
      expect((error as AnchorError).code).toBe('unsupported_asset');
    }
  });

  it('discovers over the network from the home domain alone', async () => {
    const { fetch, calls } = stubFetch({ '.well-known/stellar.toml': { text: TOML } });
    const provider = new SepAnchorProvider({ fetch, expectedNetworkPassphrase: TESTNET });

    const capabilities = await provider.discover('tr-mock-anchor.fly.dev');

    expect(calls[0]?.url).toBe('https://tr-mock-anchor.fly.dev/.well-known/stellar.toml');
    expect(capabilities.transferServer).toBe(CAPABILITIES.transferServer);
  });

  it('maps an unreachable anchor to a clear error', async () => {
    const { fetch } = stubFetch({ '.well-known': { throws: true } });
    const provider = new SepAnchorProvider({ fetch });

    await expect(provider.discover('tr-mock-anchor.fly.dev')).rejects.toMatchObject({
      code: 'anchor_unavailable',
    });
  });

  it('maps a non-200 toml to discovery_failed', async () => {
    const { fetch } = stubFetch({ '.well-known': { status: 500, text: 'boom' } });
    const provider = new SepAnchorProvider({ fetch });

    await expect(provider.discover('tr-mock-anchor.fly.dev')).rejects.toMatchObject({
      code: 'discovery_failed',
      httpStatus: 500,
    });
  });
});

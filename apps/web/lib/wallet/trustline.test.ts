import { describe, expect, it } from 'vitest';
import { usdcTrustlineStatus } from './trustline';
import { testnetDeployment } from './config';

describe('approved Testnet USDC trustline detection', () => {
  it('requires the exact code, asset type, and approved issuer', () => {
    expect(usdcTrustlineStatus([{ asset_type: 'native' }])).toBe('missing');
    expect(
      usdcTrustlineStatus([
        {
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: 'GOTHER',
        },
      ]),
    ).toBe('missing');
    expect(
      usdcTrustlineStatus([
        {
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: testnetDeployment.usdcIssuer,
        },
      ]),
    ).toBe('present');
  });
});

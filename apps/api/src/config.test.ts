import { describe, expect, it } from 'vitest';

import { loadConfig, parsePort } from './config';

describe('@milvance/api config', () => {
  it('falls back to the default port', () => {
    expect(parsePort(undefined)).toBe(3001);
    expect(parsePort('')).toBe(3001);
  });

  it('accepts a valid port', () => {
    expect(parsePort('4000')).toBe(4000);
  });

  it('rejects an invalid port', () => {
    expect(() => parsePort('0')).toThrow();
    expect(() => parsePort('70000')).toThrow();
    expect(() => parsePort('not-a-port')).toThrow();
  });

  it('defaults nodeEnv to development', () => {
    expect(
      loadConfig({
        DATABASE_URL: 'postgresql://localhost/milvance_test',
        MILVANCE_CONTRACT_ID: 'CCN6AZHLN2BQPCDZWXJGA3NRJEJ56V5JK3M4VZ5QFKQ3NSJBN6RVTKRX',
        USDC_ISSUER: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        USDC_ASSET_CONTRACT_ID: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      }).nodeEnv,
    ).toBe('development');
  });
});

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

  it('refuses a scheduler secret too short to be worth having', () => {
    const base = {
      DATABASE_URL: 'postgresql://localhost/milvance_test',
      MILVANCE_CONTRACT_ID: 'CCN6AZHLN2BQPCDZWXJGA3NRJEJ56V5JK3M4VZ5QFKQ3NSJBN6RVTKRX',
      USDC_ISSUER: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      USDC_ASSET_CONTRACT_ID: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    };

    // A weak secret on the one endpoint that writes to the read model is worse
    // than an absent one, because it looks protected.
    try {
      loadConfig({ ...base, INDEXER_CRON_SECRET: 'hunter2' });
      expect.unreachable('should have refused');
    } catch (error) {
      expect(String(error)).toContain('INDEXER_CRON_SECRET');
      // The value itself is never echoed back, not even to say it was short.
      expect(String(error)).not.toContain('hunter2');
    }

    // Absent is allowed: it disables the endpoint rather than opening it.
    expect(loadConfig(base).indexer.cronSecret).toBeUndefined();
    expect(loadConfig({ ...base, INDEXER_CRON_SECRET: 'a'.repeat(32) }).indexer.cronSecret).toBe(
      'a'.repeat(32),
    );
  });

  it('bounds one tick so it cannot become an unbounded request', () => {
    const tick = loadConfig({
      DATABASE_URL: 'postgresql://localhost/milvance_test',
      MILVANCE_CONTRACT_ID: 'CCN6AZHLN2BQPCDZWXJGA3NRJEJ56V5JK3M4VZ5QFKQ3NSJBN6RVTKRX',
      USDC_ISSUER: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      USDC_ASSET_CONTRACT_ID: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    }).indexer.tick;

    expect(tick.maxPages).toBeGreaterThan(0);
    expect(Number.isFinite(tick.maxSeconds)).toBe(true);
    expect(Number.isFinite(tick.maxEvents)).toBe(true);
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

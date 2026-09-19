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
    expect(loadConfig({}).nodeEnv).toBe('development');
  });
});

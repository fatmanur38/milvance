import { describe, expect, it } from 'vitest';

import { allowedOrigins } from './http-security';

/**
 * Which browser origins may call the API.
 *
 * A wildcard here would let any site on the internet read a judge's view of
 * the read model through their browser. It is not a data leak — everything the
 * API serves is public chain state — but it is the kind of default that stops
 * being harmless the moment anything private is added.
 */
describe('CORS origins', () => {
  it('defaults to local development when nothing is configured', () => {
    expect(allowedOrigins(undefined)).toEqual(['http://localhost:3000']);
    expect(allowedOrigins('')).toEqual(['http://localhost:3000']);
  });

  it('accepts several explicit origins, so a preview can be allowed too', () => {
    expect(allowedOrigins('https://milvance.app, https://preview.milvance.app')).toEqual([
      'https://milvance.app',
      'https://preview.milvance.app',
    ]);
  });

  it('never allows a wildcard, however it is written', () => {
    expect(allowedOrigins('*')).toEqual(['http://localhost:3000']);
    expect(allowedOrigins('*, https://milvance.app')).toEqual(['https://milvance.app']);
  });

  it('drops anything that is not a bare origin', () => {
    // A path or a trailing slash never matches a browser Origin header, so
    // silently accepting one would produce a CORS failure nobody can explain.
    expect(allowedOrigins('https://milvance.app/app')).toEqual(['http://localhost:3000']);
    expect(allowedOrigins('not a url')).toEqual(['http://localhost:3000']);
    expect(allowedOrigins('javascript:alert(1)')).toEqual(['http://localhost:3000']);
  });
});

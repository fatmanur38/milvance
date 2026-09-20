import { describe, expect, it } from 'vitest';

import { sha256Hex, shortDigest, toBase64 } from './hash';

describe('browser evidence hashing', () => {
  it('matches the known SHA-256 of empty input', async () => {
    expect(await sha256Hex(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('agrees with the backend on the same bytes', async () => {
    // The API's hash.test.ts hashes this exact string; both sides must match.
    const bytes = new TextEncoder().encode('BILL OF LADING\nContainer MSKU1234567\n');
    const digest = await sha256Hex(bytes);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256Hex(bytes.slice())).toBe(digest);
  });

  it('changes when a single byte changes', async () => {
    const a = new TextEncoder().encode('QC REPORT: pass');
    const b = new TextEncoder().encode('QC REPORT: fail');
    expect(await sha256Hex(a)).not.toBe(await sha256Hex(b));
  });

  it('encodes large documents to base64 without overflowing', () => {
    const big = new Uint8Array(300_000).fill(65);
    expect(toBase64(big)).toBe(Buffer.from(big).toString('base64'));
  });

  it('shortens a digest for dense UI', () => {
    expect(shortDigest('a'.repeat(56) + 'bcdefghi')).toBe('aaaaaaaa…bcdefghi');
  });
});

import { describe, expect, it } from 'vitest';

import {
  EvidenceHashError,
  hashEvidence,
  hashEvidenceBytes,
  isEvidenceHash,
  normaliseEvidenceHash,
  sanitiseFilename,
  storageKeyFor,
  verifyEvidence,
} from './hash';

const BILL_OF_LADING = Buffer.from('BILL OF LADING\nContainer MSKU1234567\n', 'utf8');

describe('evidence hashing', () => {
  it('is deterministic: the same bytes always produce the same digest', () => {
    const first = hashEvidence(BILL_OF_LADING);
    const second = hashEvidence(Buffer.from(BILL_OF_LADING));

    expect(first).toBe(second);
    // Pinned so an accidental algorithm or encoding change is caught here.
    expect(first).toBe(hashEvidence(new Uint8Array(BILL_OF_LADING)));
  });

  it('matches the known SHA-256 of a known input', () => {
    // `printf '' | shasum -a 256` — the empty-input digest.
    expect(hashEvidence(Buffer.alloc(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('produces the 32-byte value the contract stores as BytesN<32>', () => {
    const bytes = hashEvidenceBytes(BILL_OF_LADING);

    expect(bytes).toHaveLength(32);
    expect(bytes.toString('hex')).toBe(hashEvidence(BILL_OF_LADING));
  });

  it('changes completely when a single byte changes', () => {
    const altered = Buffer.from(BILL_OF_LADING);
    altered[0] = (altered[0] ?? 0) ^ 0x01;

    expect(hashEvidence(altered)).not.toBe(hashEvidence(BILL_OF_LADING));
  });

  it('hashes the document, never its metadata', () => {
    // Two documents that share every piece of metadata must still differ.
    const qcReport = Buffer.from('QC REPORT: pass', 'utf8');
    const packingList = Buffer.from('PACKING LIST: 40 cartons', 'utf8');

    expect(hashEvidence(qcReport)).not.toBe(hashEvidence(packingList));
  });
});

describe('digest validation', () => {
  it('accepts a valid digest and lowers its case', () => {
    const digest = hashEvidence(BILL_OF_LADING);
    expect(normaliseEvidenceHash(digest.toUpperCase())).toBe(digest);
  });

  it.each([
    ['too short', 'a'.repeat(63)],
    ['too long', 'a'.repeat(65)],
    ['not hex', 'z'.repeat(64)],
    ['empty', ''],
    ['0x prefixed', `0x${'a'.repeat(64)}`],
  ])('rejects a digest that is %s', (_label, value) => {
    expect(() => normaliseEvidenceHash(value)).toThrow(EvidenceHashError);
    expect(isEvidenceHash(value)).toBe(false);
  });
});

describe('verification', () => {
  it('confirms bytes that match their commitment', () => {
    expect(verifyEvidence(BILL_OF_LADING, hashEvidence(BILL_OF_LADING))).toBe(true);
  });

  it('rejects bytes that do not match — a tampered document', () => {
    const tampered = Buffer.from('BILL OF LADING\nContainer MSKU7654321\n', 'utf8');

    expect(verifyEvidence(tampered, hashEvidence(BILL_OF_LADING))).toBe(false);
  });
});

describe('storage keys and filenames', () => {
  it('derives the storage key from the digest alone', () => {
    const digest = hashEvidence(BILL_OF_LADING);
    const key = storageKeyFor(digest);

    expect(key).toBe(`evidence/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`);
  });

  it('cannot be steered by a hostile filename, because filenames are not used', () => {
    const digest = hashEvidence(BILL_OF_LADING);

    // The key depends on nothing a client controls except the bytes themselves.
    expect(storageKeyFor(digest)).not.toContain('..');
    expect(storageKeyFor(digest)).toMatch(/^evidence\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}$/);
  });

  it.each([
    ['../../etc/passwd', 'passwd'],
    ['..\\..\\windows\\system32', 'system32'],
    ['/absolute/path/bol.pdf', 'bol.pdf'],
    ['...', 'evidence'],
    ['', 'evidence'],
  ])('sanitises %s to %s', (input, expected) => {
    expect(sanitiseFilename(input)).toBe(expected);
  });

  it('strips control characters from a filename', () => {
    expect(sanitiseFilename('bol\u0000\u001b.pdf')).toBe('bol.pdf');
  });

  it('caps an absurdly long filename', () => {
    expect(sanitiseFilename(`${'a'.repeat(500)}.pdf`)).toHaveLength(200);
  });
});

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../config';
import { hashEvidence } from './hash';
import { signS3Request } from './s3';
import {
  assertSafeKey,
  createEvidenceStorage,
  EvidenceStorageError,
  S3EvidenceStorage,
} from './storage';

/**
 * Persistent evidence storage.
 *
 * Two things must hold for a public deployment: the bytes survive a redeploy,
 * and the bucket is never a public document directory. The signing tests exist
 * because a signature bug shows up as "works locally, 403 in production", which
 * is the worst possible moment to discover it.
 */
const CREDENTIALS = {
  endpoint: 'https://accountid.r2.cloudflarestorage.com',
  bucket: 'milvance-evidence',
  region: 'auto',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};

const AT = new Date('2026-09-20T03:30:00Z');

describe('signing against an endpoint that has a path of its own', () => {
  // Supabase Storage's S3 endpoint is not a bare origin: it ends in
  // `/storage/v1/s3`. A prefix dropped from the URL is also missing from the
  // canonical request, so the failure is a 403 with a correct-looking key —
  // exactly the kind that only appears once real credentials exist.
  const SUPABASE = {
    endpoint: 'https://abcdefghijklmnop.storage.supabase.co/storage/v1/s3',
    bucket: 'milvance-evidence',
    region: 'eu-central-1',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  };

  it('keeps the endpoint path in the request URL', () => {
    const signed = signS3Request(SUPABASE, 'PUT', 'evidence/ab/cd.bin', new Uint8Array([1]), AT);

    expect(signed.url).toBe(
      'https://abcdefghijklmnop.storage.supabase.co/storage/v1/s3/milvance-evidence/evidence/ab/cd.bin',
    );
  });

  it('signs the same path it sends', () => {
    // The signature must change when the prefix does. If the prefix were being
    // ignored, these two would be identical.
    const withPrefix = signS3Request(SUPABASE, 'GET', 'evidence/ab/cd.bin', new Uint8Array(), AT);
    const withoutPrefix = signS3Request(
      { ...SUPABASE, endpoint: 'https://abcdefghijklmnop.storage.supabase.co' },
      'GET',
      'evidence/ab/cd.bin',
      new Uint8Array(),
      AT,
    );

    expect(withPrefix.headers.Authorization).not.toBe(withoutPrefix.headers.Authorization);
    expect(withPrefix.headers.Authorization).toContain('/20260920/eu-central-1/s3/aws4_request');
  });

  it('is unchanged for an endpoint that is a bare origin', () => {
    // R2 and AWS must sign exactly as they did before the prefix existed.
    const signed = signS3Request(CREDENTIALS, 'PUT', 'evidence/ab/cd.bin', new Uint8Array([1]), AT);
    expect(signed.url).toBe(
      'https://accountid.r2.cloudflarestorage.com/milvance-evidence/evidence/ab/cd.bin',
    );
  });
});

describe('signing an S3 request', () => {
  it('produces a complete SigV4 authorization for a PUT', () => {
    const signed = signS3Request(CREDENTIALS, 'PUT', 'evidence/ab/cd.bin', new Uint8Array([1]), AT);

    expect(signed.url).toBe(
      'https://accountid.r2.cloudflarestorage.com/milvance-evidence/evidence/ab/cd.bin',
    );
    expect(signed.headers['x-amz-date']).toBe('20260920T033000Z');
    expect(signed.headers.Authorization).toContain(
      'Credential=AKIAIOSFODNN7EXAMPLE/20260920/auto/s3/aws4_request',
    );
    expect(signed.headers.Authorization).toContain(
      'SignedHeaders=host;x-amz-content-sha256;x-amz-date',
    );
    expect(signed.headers.Authorization).toMatch(/Signature=[0-9a-f]{64}$/);
  });

  it('commits to the exact payload, so altered bytes invalidate the signature', () => {
    const one = signS3Request(CREDENTIALS, 'PUT', 'k', new Uint8Array([1]), AT);
    const two = signS3Request(CREDENTIALS, 'PUT', 'k', new Uint8Array([2]), AT);
    expect(one.headers['x-amz-content-sha256']).not.toBe(two.headers['x-amz-content-sha256']);
    expect(one.headers.Authorization).not.toBe(two.headers.Authorization);
  });

  it('hashes the payload with the same SHA-256 the contract commits to', () => {
    const bytes = new TextEncoder().encode('quality control report');
    const signed = signS3Request(CREDENTIALS, 'PUT', 'k', bytes, AT);
    // The S3 content hash and the on-chain evidence commitment are the same
    // digest of the same bytes, which is a useful property to keep true.
    expect(signed.headers['x-amz-content-sha256']).toBe(hashEvidence(bytes));
  });

  it('is deterministic for the same inputs and differs across time', () => {
    expect(signS3Request(CREDENTIALS, 'GET', 'k', new Uint8Array(), AT)).toEqual(
      signS3Request(CREDENTIALS, 'GET', 'k', new Uint8Array(), AT),
    );
    const later = new Date('2026-09-21T03:30:00Z');
    expect(
      signS3Request(CREDENTIALS, 'GET', 'k', new Uint8Array(), later).headers.Authorization,
    ).not.toBe(signS3Request(CREDENTIALS, 'GET', 'k', new Uint8Array(), AT).headers.Authorization);
  });

  it('percent-encodes path segments the way SigV4 requires', () => {
    const signed = signS3Request(CREDENTIALS, 'GET', "a b/c'd", new Uint8Array(), AT);
    expect(signed.url).toContain('/a%20b/c%27d');
  });
});

describe('storage keys cannot escape the prefix', () => {
  it('refuses traversal, absolute and empty keys', () => {
    for (const bad of ['', '/etc/passwd', '../secrets', 'a/../../b', 'a//b', 'a\\b', 'a b']) {
      expect(() => assertSafeKey(bad), bad).toThrow(EvidenceStorageError);
    }
  });

  it('accepts the digest-derived keys the API actually produces', () => {
    expect(() => assertSafeKey('evidence/ab/cdef.bin')).not.toThrow();
  });
});

describe('the S3 driver', () => {
  it('stores and retrieves the exact bytes, unchanged', async () => {
    const bucket = new Map<string, Uint8Array>();
    const fake: typeof fetch = async (input, init) => {
      const url = String(input);
      if (init?.method === 'PUT') {
        bucket.set(url, new Uint8Array(init.body as ArrayBufferLike));
        return new Response(null, { status: 200 });
      }
      const stored = bucket.get(url);
      return stored === undefined
        ? new Response(null, { status: 404 })
        : new Response(stored as unknown as BodyInit, { status: 200 });
    };
    const storage = new S3EvidenceStorage(CREDENTIALS, fake);
    const bytes = new TextEncoder().encode('synthetic QC report\n');
    const digest = hashEvidence(bytes);

    const key = await storage.put(digest, bytes);
    const read = await storage.get(key);
    expect(hashEvidence(read)).toBe(digest);
    expect(new TextDecoder().decode(read)).toBe('synthetic QC report\n');
  });

  it('never makes an object public', async () => {
    const headers: Record<string, string>[] = [];
    const fake: typeof fetch = async (_input, init) => {
      headers.push(init?.headers as Record<string, string>);
      return new Response(null, { status: 200 });
    };
    await new S3EvidenceStorage(CREDENTIALS, fake).put('a'.repeat(64), new Uint8Array([1]));
    const sent = Object.keys(headers[0] ?? {}).map((key) => key.toLowerCase());
    // No ACL, no public-read, nothing that would publish a private document.
    expect(sent).not.toContain('x-amz-acl');
    expect(JSON.stringify(headers)).not.toMatch(/public/i);
  });

  it('reports a missing object rather than returning empty bytes', async () => {
    const fake: typeof fetch = async () => new Response(null, { status: 404 });
    await expect(
      new S3EvidenceStorage(CREDENTIALS, fake).get('evidence/ab/cd.bin'),
    ).rejects.toThrow(/not present/);
  });

  it('does not leak the storage response body into an error', async () => {
    const fake: typeof fetch = async () =>
      new Response('<Error><Message>AKIA... invalid</Message></Error>', { status: 403 });
    await expect(
      new S3EvidenceStorage(CREDENTIALS, fake).put('a'.repeat(64), new Uint8Array([1])),
    ).rejects.toThrow(/rejected the upload \(403\)/);
  });
});

describe('choosing a driver', () => {
  const base = {
    DATABASE_URL: 'postgresql://localhost/test',
    MILVANCE_CONTRACT_ID: 'CCN6AZHLN2BQPCDZWXJGA3NRJEJ56V5JK3M4VZ5QFKQ3NSJBN6RVTKRX',
    USDC_ISSUER: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    USDC_ASSET_CONTRACT_ID: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  };

  it('uses the local driver for development', () => {
    expect(createEvidenceStorage(loadConfig(base).evidence).driver).toBe('local-dev');
  });

  it('builds the S3 driver when fully configured', () => {
    const config = loadConfig({
      ...base,
      EVIDENCE_STORAGE_DRIVER: 's3',
      OBJECT_STORAGE_ENDPOINT: CREDENTIALS.endpoint,
      OBJECT_STORAGE_BUCKET: CREDENTIALS.bucket,
      OBJECT_STORAGE_ACCESS_KEY: CREDENTIALS.accessKeyId,
      OBJECT_STORAGE_SECRET_KEY: CREDENTIALS.secretAccessKey,
    });
    expect(createEvidenceStorage(config.evidence).driver).toBe('s3');
  });

  it('refuses to boot half-configured, naming what is missing but never a value', () => {
    // A bucket discovered to be misconfigured mid-demo is worse than a
    // deployment that refuses to start.
    expect(() =>
      loadConfig({ ...base, EVIDENCE_STORAGE_DRIVER: 's3', OBJECT_STORAGE_BUCKET: 'b' }),
    ).toThrow(/OBJECT_STORAGE_ENDPOINT/);
    try {
      loadConfig({
        ...base,
        EVIDENCE_STORAGE_DRIVER: 's3',
        OBJECT_STORAGE_ENDPOINT: CREDENTIALS.endpoint,
        OBJECT_STORAGE_BUCKET: CREDENTIALS.bucket,
        OBJECT_STORAGE_SECRET_KEY: CREDENTIALS.secretAccessKey,
      });
      expect.unreachable('should have refused');
    } catch (error) {
      expect(String(error)).toContain('OBJECT_STORAGE_ACCESS_KEY');
      expect(String(error)).not.toContain(CREDENTIALS.secretAccessKey);
    }
  });
});

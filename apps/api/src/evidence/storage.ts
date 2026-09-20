import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import type { EvidenceConfig } from '../config';
import { storageKeyFor } from './hash';
import { signS3Request, type S3Credentials } from './s3';

/**
 * Object-storage boundary for evidence documents.
 *
 * AGENT.md §11 specifies S3-compatible storage / R2. The interface below is
 * that shape; the driver shipped here writes to a local directory so the
 * hackathon runs without cloud credentials, and no production key material is
 * ever committed to this repository.
 *
 * The bytes live here. The chain holds only the SHA-256 commitment, and
 * PostgreSQL holds only metadata plus the key.
 */
export interface EvidenceStorage {
  readonly driver: string;
  put(contentHash: string, bytes: Uint8Array): Promise<string>;
  get(storageKey: string): Promise<Uint8Array>;
}

export class EvidenceStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceStorageError';
  }
}

/**
 * Local filesystem driver for development.
 *
 * Every path is derived from the digest and then re-checked against the root
 * before any I/O. The check is belt-and-braces — a key built from a 64-character
 * hex digest cannot escape — but the assertion means a future driver change
 * cannot quietly introduce traversal.
 */
export class LocalEvidenceStorage implements EvidenceStorage {
  readonly driver = 'local-dev';
  private readonly root: string;

  constructor(directory: string) {
    this.root = resolve(directory);
  }

  private pathFor(storageKey: string): string {
    const candidate = resolve(join(this.root, storageKey));
    if (candidate !== this.root && !candidate.startsWith(this.root + sep)) {
      throw new EvidenceStorageError('Refusing a storage key that escapes the evidence root');
    }
    return candidate;
  }

  async put(contentHash: string, bytes: Uint8Array): Promise<string> {
    const key = storageKeyFor(contentHash);
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    return key;
  }

  async get(storageKey: string): Promise<Uint8Array> {
    try {
      return await readFile(this.pathFor(storageKey));
    } catch (error) {
      if (error instanceof EvidenceStorageError) {
        throw error;
      }
      throw new EvidenceStorageError('Evidence object is not present in storage');
    }
  }
}

/**
 * S3-compatible driver for deployment (AGENT.md §11: S3 / R2 equivalent).
 *
 * The bucket is PRIVATE. Nothing here makes an object public, there is no ACL
 * header and no presigned read URL: retrieval goes through the API, which is
 * the only place that holds the credentials. A deployment that exposes the
 * bucket directly would put private evidence documents on the open web, which
 * is precisely what the off-chain evidence model exists to avoid.
 *
 * The storage key is derived from the digest, so a caller cannot choose where
 * bytes land, and the same traversal assertion as the local driver applies.
 */
export class S3EvidenceStorage implements EvidenceStorage {
  readonly driver = 's3';

  constructor(
    private readonly credentials: S3Credentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async put(contentHash: string, bytes: Uint8Array): Promise<string> {
    const key = storageKeyFor(contentHash);
    assertSafeKey(key);
    const signed = signS3Request(this.credentials, 'PUT', key, bytes);
    const response = await this.fetchImpl(signed.url, {
      method: 'PUT',
      headers: signed.headers,
      body: Buffer.from(bytes),
    });
    if (!response.ok) {
      // The status is useful; the body may echo request details, so it stays out.
      throw new EvidenceStorageError(`Evidence storage rejected the upload (${response.status})`);
    }
    return key;
  }

  async get(storageKey: string): Promise<Uint8Array> {
    assertSafeKey(storageKey);
    const signed = signS3Request(this.credentials, 'GET', storageKey, new Uint8Array());
    const response = await this.fetchImpl(signed.url, { method: 'GET', headers: signed.headers });
    if (!response.ok) {
      throw new EvidenceStorageError('Evidence object is not present in storage');
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}

/**
 * Storage keys are derived from a hex digest, never from user input.
 *
 * Checked anyway: `..` in an object key is meaningful to some gateways, and a
 * future key scheme must not be able to reach outside the prefix quietly.
 */
export function assertSafeKey(key: string): void {
  if (
    key === '' ||
    key.startsWith('/') ||
    key.includes('..') ||
    key.includes('//') ||
    !/^[A-Za-z0-9/._-]+$/.test(key)
  ) {
    throw new EvidenceStorageError('Refusing a storage key that escapes the evidence prefix');
  }
}

export function createEvidenceStorage(config: EvidenceConfig): EvidenceStorage {
  if (config.driver === 's3') {
    const missing = (['endpoint', 'bucket', 'region', 'accessKeyId', 'secretAccessKey'] as const)
      .filter((field) => config.s3?.[field] === undefined || config.s3[field] === '')
      .map((field) => field);
    if (config.s3 === undefined || missing.length > 0) {
      // Fail at boot rather than on the first upload: a half-configured bucket
      // discovered mid-demo is worse than a deployment that refuses to start.
      // The NAMES of missing variables are safe to print; values never are.
      throw new EvidenceStorageError(
        `S3 evidence storage is missing configuration: ${missing.join(', ')}`,
      );
    }
    return new S3EvidenceStorage(config.s3);
  }
  return new LocalEvidenceStorage(config.localDirectory);
}

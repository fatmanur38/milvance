import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import type { EvidenceConfig } from '../config';
import { storageKeyFor } from './hash';

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

export function createEvidenceStorage(config: EvidenceConfig): EvidenceStorage {
  if (config.driver === 's3') {
    // Deliberately not implemented in PKG-08: wiring a real bucket would mean
    // introducing cloud credentials into a repository that becomes public.
    // Configure `EVIDENCE_STORAGE_DRIVER=local-dev` for the hackathon.
    throw new EvidenceStorageError(
      'S3 evidence storage is not configured in this build; set EVIDENCE_STORAGE_DRIVER=local-dev',
    );
  }
  return new LocalEvidenceStorage(config.localDirectory);
}

import { createHash } from 'node:crypto';

/**
 * Evidence content hashing.
 *
 * The rule from AGENT.md §26, stated plainly because it is easy to get subtly
 * wrong: the digest commits to the DOCUMENT BYTES. Not a path, not a URL, not a
 * metadata envelope, not a filename. If any of those were hashed instead, the
 * on-chain commitment would prove nothing about the document an attestor read.
 *
 * Format: SHA-256, 32 bytes, rendered as 64 lower-case hex characters. That is
 * exactly what `submit_evidence(hash: BytesN<32>)` expects, so the same string
 * this function returns is what the supplier's wallet signs.
 */

export const EVIDENCE_HASH_BYTES = 32;
export const EVIDENCE_HASH_HEX_LENGTH = EVIDENCE_HASH_BYTES * 2;

const HEX_DIGEST = /^[0-9a-f]{64}$/;

export class EvidenceHashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceHashError';
  }
}

/** SHA-256 of the exact bytes, as lower-case hex. */
export function hashEvidence(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The same digest as the 32 raw bytes the contract stores. */
export function hashEvidenceBytes(bytes: Uint8Array): Buffer {
  return createHash('sha256').update(bytes).digest();
}

/**
 * Normalise and validate a digest supplied by a client.
 *
 * Upper case is accepted and lowered — the contract stores bytes, so case is a
 * presentation detail — but nothing else is repaired. A 63-character string is
 * a bug, not something to pad.
 */
export function normaliseEvidenceHash(value: string): string {
  const lowered = value.trim().toLowerCase();
  if (!HEX_DIGEST.test(lowered)) {
    throw new EvidenceHashError(
      'Evidence hash must be 64 lower-case hex characters (SHA-256, the format submit_evidence expects)',
    );
  }
  return lowered;
}

export function isEvidenceHash(value: string): boolean {
  return HEX_DIGEST.test(value.trim().toLowerCase());
}

/**
 * Verify that stored bytes still match their recorded commitment.
 *
 * Used before telling anyone a document is the one the chain attests to.
 */
export function verifyEvidence(bytes: Uint8Array, expectedHash: string): boolean {
  return hashEvidence(bytes) === normaliseEvidenceHash(expectedHash);
}

/**
 * Object-storage key for a document.
 *
 * Derived from the digest alone. The user-supplied filename is NEVER part of
 * the key, which is what makes path traversal structurally impossible rather
 * than merely filtered: `../../etc/passwd` as a filename cannot influence where
 * anything is written.
 */
export function storageKeyFor(contentHash: string): string {
  const digest = normaliseEvidenceHash(contentHash);
  return `evidence/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`;
}

/**
 * Reduce a client-supplied filename to something safe to store and display.
 *
 * Only the basename survives, separators and control characters are stripped,
 * and the result is length-capped. It is metadata for humans; nothing derives a
 * filesystem path from it.
 */
export function sanitiseFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex -- deliberately stripping control chars
  const withoutControls = base.replace(/[\u0000-\u001f\u007f]/g, '');
  const cleaned = withoutControls.replace(/^\.+/, '').trim();
  if (cleaned === '') {
    return 'evidence';
  }
  return cleaned.slice(0, 200);
}

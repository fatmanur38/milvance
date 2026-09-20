/**
 * Browser-side evidence hashing.
 *
 * The digest commits to the DOCUMENT BYTES, exactly as the backend and the
 * contract expect: SHA-256, 32 bytes, rendered as 64 lower-case hex characters
 * (the `BytesN<32>` that `submit_evidence` stores). Computing it here lets the
 * person see the fingerprint before uploading, and lets the server's own hash
 * be checked against it — two independent computations that must agree.
 */

export const MAX_EVIDENCE_BYTES = 25 * 1024 * 1024;

export const DOCUMENT_LABELS = [
  'QC report',
  'Bill of lading',
  'Packing list',
  'Carrier receipt',
  'Delivery confirmation',
  'Production photos',
  'Other',
] as const;

export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // Copy into a fresh ArrayBuffer so SubtleCrypto never sees a shared or offset view.
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Base64 without blowing the call stack on large files. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

/** `abcd…wxyz` for a digest in dense layouts; the full value stays available. */
export function shortDigest(hex: string): string {
  return `${hex.slice(0, 8)}…${hex.slice(-8)}`;
}

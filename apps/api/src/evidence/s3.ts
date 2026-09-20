import { createHash, createHmac } from 'node:crypto';

/**
 * A minimal S3-compatible client: PUT and GET one object, signed with SigV4.
 *
 * Written rather than pulled in because the API needs exactly two operations
 * against one bucket, and the alternative is several megabytes of SDK in a
 * repository that becomes public and has to be read by judges. Every byte of
 * the signing process is here to be audited.
 *
 * Works against AWS S3, Cloudflare R2, MinIO and anything else that speaks
 * SigV4 with path-style addressing. Credentials are read from server-side
 * configuration only; nothing here is reachable from the browser bundle.
 */

export interface S3Credentials {
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

const UNSIGNED_HEADERS = 'host;x-amz-content-sha256;x-amz-date';

function sha256Hex(payload: Uint8Array | string): string {
  return createHash('sha256').update(payload).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/**
 * Percent-encodes a path segment the way SigV4 requires.
 *
 * `encodeURIComponent` leaves `!'()*` alone and AWS does not, so a key
 * containing one would sign differently from how it is sent. Our keys are hex
 * and slashes, but the canonicalisation has to be right regardless — a signing
 * bug that only appears for unusual keys is the worst kind.
 */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalPath(bucket: string, key: string): string {
  const segments = key.split('/').filter((part) => part !== '');
  return `/${encodeSegment(bucket)}/${segments.map(encodeSegment).join('/')}`;
}

export interface SignedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
}

/**
 * Signs one request. `now` is injectable so signatures are testable rather
 * than only observable.
 */
export function signS3Request(
  credentials: S3Credentials,
  method: 'PUT' | 'GET',
  key: string,
  payload: Uint8Array,
  now: Date = new Date(),
): SignedRequest {
  const endpoint = new URL(credentials.endpoint);
  const host = endpoint.host;
  const amzDate = `${now.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(payload);
  const path = canonicalPath(credentials.bucket, key);

  const canonicalRequest = [
    method,
    path,
    '',
    `host:${host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`,
    '',
    UNSIGNED_HEADERS,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${credentials.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, dateStamp), credentials.region), 's3'),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  return {
    url: `${endpoint.origin}${path}`,
    headers: {
      Host: host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, ` +
        `SignedHeaders=${UNSIGNED_HEADERS}, Signature=${signature}`,
    },
  };
}

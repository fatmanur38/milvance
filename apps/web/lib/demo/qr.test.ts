import { describe, expect, it } from 'vitest';

import { inviteUrl } from './invite';
import { qrMatrix, qrPayloadSafety, qrSvgPath, QR_ALLOWED_PARAMS } from './qr';

const link = inviteUrl('https://milvance.example', {
  orderId: '42',
  role: 'supplier',
  templateId: 'fast-task',
});

describe('what a QR code may carry', () => {
  it('accepts an ordinary invite link', () => {
    expect(qrPayloadSafety(link)).toEqual({ safe: true });
  });

  it('allows only the four invite parameters', () => {
    expect([...QR_ALLOWED_PARAMS].sort()).toEqual(['milestone', 'order', 'role', 'template']);
  });

  it.each([
    ['a session token', 'https://milvance.example/app?jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.x'],
    ['a bearer header smuggled into a link', 'https://milvance.example/app?authorization=Bearer+x'],
    ['an api key', 'https://milvance.example/app?apikey=abc'],
    ['a database url', 'https://milvance.example/app?database_url=postgres://u:p@h/db'],
    ['basic-auth credentials', 'https://user:pass@milvance.example/app?order=1&role=buyer'],
    ['a fragment', 'https://milvance.example/app/trade-lab/join?order=1&role=buyer#token'],
    ['a javascript url', 'javascript:alert(1)'],
    ['a data url', 'data:text/html,<script>alert(1)</script>'],
    ['something that is not a url', 'order=1&role=buyer'],
    [
      'an unknown parameter',
      'https://milvance.example/app/trade-lab/join?order=1&role=buyer&admin=1',
    ],
  ])('refuses %s', (_case, payload) => {
    expect(qrPayloadSafety(payload).safe).toBe(false);
  });

  it('refuses a Stellar SECRET key even in an otherwise valid link', () => {
    // Public keys (G…) are fine and unavoidable; secret keys (S…) never are.
    const secret = `S${'A'.repeat(55)}`;
    const payload = `https://milvance.example/app/trade-lab/join?order=1&role=buyer&template=${secret}`;
    expect(qrPayloadSafety(payload).safe).toBe(false);
  });

  it('never refuses a payload for containing a public address', () => {
    const payload = 'https://milvance.example/app/trade-lab/join?order=1&role=funder';
    expect(qrPayloadSafety(payload).safe).toBe(true);
  });
});

describe('rendering a QR code', () => {
  it('encodes the payload deterministically', () => {
    const first = qrMatrix(link);
    const second = qrMatrix(link);
    expect(first.size).toBeGreaterThan(20);
    expect(first.dark).toEqual(second.dark);
    expect(first.dark.length).toBe(first.size * first.size);
    // A printed invite and an on-screen one must be the same code.
    expect(qrSvgPath(first)).toBe(qrSvgPath(second));
  });

  it('draws something', () => {
    expect(qrSvgPath(qrMatrix(link)).startsWith('M')).toBe(true);
  });

  it('refuses to draw an unsafe payload at all', () => {
    expect(() => qrMatrix('https://milvance.example/app?jwt=eyJhbGciOi.abc.def')).toThrow();
  });
});

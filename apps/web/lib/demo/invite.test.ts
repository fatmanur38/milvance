import { describe, expect, it } from 'vitest';

import { WALLETS } from '../test/fixtures';
import {
  expectedAddressFor,
  INVITE_PATH,
  inviteDestination,
  invitePath,
  inviteQuery,
  inviteUrl,
  isDeviceLocal,
  parseInvite,
  shareOrigin,
} from './invite';

const parties = {
  buyer: WALLETS.buyer,
  supplier: WALLETS.supplier,
  attestor: WALLETS.attestor,
  resolver: WALLETS.resolver,
};

describe('building invites', () => {
  it('carries only the four known parameters', () => {
    const query = new URLSearchParams(
      inviteQuery({ orderId: '42', role: 'supplier', milestoneId: '7', templateId: 'fast-task' }),
    );
    expect([...query.keys()].sort()).toEqual(['milestone', 'order', 'role', 'template']);
    expect(query.get('order')).toBe('42');
    expect(query.get('role')).toBe('supplier');
  });

  it('drops an unknown template instead of reflecting it', () => {
    const query = new URLSearchParams(
      inviteQuery({ orderId: '42', role: 'funder', templateId: '<script>alert(1)</script>' }),
    );
    expect(query.get('template')).toBeNull();
    expect(query.toString()).not.toContain('script');
  });

  it('drops a malformed milestone id', () => {
    const query = new URLSearchParams(
      inviteQuery({ orderId: '42', role: 'funder', milestoneId: '0; DROP TABLE' }),
    );
    expect(query.get('milestone')).toBeNull();
  });

  it('refuses to build a link for a nonsense order id', () => {
    expect(() => inviteQuery({ orderId: '0', role: 'supplier' })).toThrow();
    expect(() => inviteQuery({ orderId: '-1', role: 'supplier' })).toThrow();
    expect(() => inviteQuery({ orderId: 'abc', role: 'supplier' })).toThrow();
  });

  it('builds an absolute link on the current origin', () => {
    expect(inviteUrl('http://localhost:3000', { orderId: '2', role: 'attestor' })).toBe(
      'http://localhost:3000/app/trade-lab/join?order=2&role=attestor',
    );
    expect(invitePath({ orderId: '2', role: 'attestor' })).toBe(
      `${INVITE_PATH}?order=2&role=attestor`,
    );
  });

  it('refuses an origin that is not http or https', () => {
    // A link that becomes `javascript:` is a script, not an invitation.
    expect(() => inviteUrl('javascript:alert(1)', { orderId: '2', role: 'buyer' })).toThrow();
    expect(() => inviteUrl('data:text/html,x', { orderId: '2', role: 'buyer' })).toThrow();
    expect(() => inviteUrl('not a url', { orderId: '2', role: 'buyer' })).toThrow();
  });
});

describe('parsing invites', () => {
  it('accepts a well-formed invite', () => {
    const result = parseInvite(new URLSearchParams('order=42&role=funder&milestone=7'));
    expect(result).toEqual({
      ok: true,
      invite: { orderId: '42', role: 'funder', milestoneId: '7', templateId: null },
    });
  });

  it('accepts the plain object Next.js hands a page', () => {
    const result = parseInvite({ order: '3', role: 'supplier', template: 'fast-task' });
    expect(result.ok && result.invite.templateId).toBe('fast-task');
  });

  it.each([
    ['no parameters at all', ''],
    ['a missing order', 'role=supplier'],
    ['a missing role', 'order=42'],
    ['order zero', 'order=0&role=supplier'],
    ['a negative order', 'order=-1&role=supplier'],
    ['a decimal order', 'order=1.5&role=supplier'],
    ['a leading zero', 'order=007&role=supplier'],
    ['an order beyond u64', 'order=18446744073709551616&role=supplier'],
    ['a word for an order', 'order=abc&role=supplier'],
    ['an unknown role', 'order=42&role=admin'],
    ['a role with markup', 'order=42&role=<script>alert(1)</script>'],
    ['a malformed milestone', 'order=42&role=funder&milestone=abc'],
  ])('rejects %s', (_case, query) => {
    const result = parseInvite(new URLSearchParams(query));
    expect(result.ok).toBe(false);
  });

  it('ignores an unknown template rather than failing the whole link', () => {
    const result = parseInvite(new URLSearchParams('order=42&role=buyer&template=../../secrets'));
    expect(result.ok && result.invite.templateId).toBeNull();
  });

  it('ignores extra parameters someone appends', () => {
    // A crafted link cannot smuggle state through: unknown keys are not read.
    const result = parseInvite(
      new URLSearchParams('order=42&role=supplier&admin=true&jwt=eyJhbGciOi.x.y'),
    );
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('jwt');
    expect(JSON.stringify(result)).not.toContain('admin');
  });

  it('takes the first value when a parameter is repeated', () => {
    const result = parseInvite(new URLSearchParams('order=42&order=99&role=supplier'));
    expect(result.ok && result.invite.orderId).toBe('42');
  });
});

describe('what an invite points at', () => {
  it('sends a funder to the milestone, or to the funding page', () => {
    expect(
      inviteDestination({ orderId: '2', role: 'funder', milestoneId: '5', templateId: null }),
    ).toBe('/app/orders/2#milestone-5');
    expect(
      inviteDestination({ orderId: '2', role: 'funder', milestoneId: null, templateId: null }),
    ).toBe('/app/funding');
  });

  it('sends a party to their order', () => {
    expect(
      inviteDestination({ orderId: '2', role: 'attestor', milestoneId: null, templateId: null }),
    ).toBe('/app/orders/2');
  });

  it('knows which address each role must be, and that a funder has none', () => {
    expect(expectedAddressFor('supplier', parties)).toBe(WALLETS.supplier);
    expect(expectedAddressFor('attestor', parties)).toBe(WALLETS.attestor);
    expect(expectedAddressFor('resolver', parties)).toBe(WALLETS.resolver);
    expect(expectedAddressFor('buyer', parties)).toBe(WALLETS.buyer);
    // The contract keeps no funder allowlist: any independent wallet may offer.
    expect(expectedAddressFor('funder', parties)).toBeNull();
  });
});

describe('which host an invite points at', () => {
  it('uses the browser origin when nothing is configured', () => {
    expect(shareOrigin(undefined, 'http://localhost:3000')).toBe('http://localhost:3000');
    expect(shareOrigin('', 'http://localhost:3000')).toBe('http://localhost:3000');
    expect(shareOrigin('   ', 'http://localhost:3000')).toBe('http://localhost:3000');
  });

  it('follows a configured public origin, keeping only the origin', () => {
    expect(shareOrigin('https://demo.example.org/ignored?x=1', 'http://localhost:3000')).toBe(
      'https://demo.example.org',
    );
  });

  it('ignores a configured value that is not a plain http(s) origin', () => {
    // A mistyped environment variable must never break a live demo, and it must
    // never become an opportunity to emit a hostile scheme.
    for (const bad of ['javascript:alert(1)', 'not a url', 'ftp://example.org', 'file:///etc']) {
      expect(shareOrigin(bad, 'http://localhost:3000')).toBe('http://localhost:3000');
    }
  });

  it('never lets a configured origin bypass invite URL validation', () => {
    expect(() =>
      inviteUrl(shareOrigin('javascript:alert(1)', ''), { orderId: '3', role: 'supplier' }),
    ).toThrow();
  });

  it('knows which origins only resolve on the machine that made them', () => {
    expect(isDeviceLocal('http://localhost:3000')).toBe(true);
    expect(isDeviceLocal('http://127.0.0.1:3000')).toBe(true);
    expect(isDeviceLocal('http://[::1]:3000')).toBe(true);
    expect(isDeviceLocal('https://demo.example.org')).toBe(false);
    expect(isDeviceLocal('http://192.168.1.20:3000')).toBe(false);
    expect(isDeviceLocal('nonsense')).toBe(false);
  });
});

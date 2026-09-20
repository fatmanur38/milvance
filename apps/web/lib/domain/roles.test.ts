import { describe, expect, it } from 'vitest';

import { order, WALLETS } from '../test/fixtures';
import { canActAsFunder, hasRole, orderRolesFor, shortAddress } from './roles';

describe('role derivation from the connected wallet', () => {
  it.each([
    ['buyer', WALLETS.buyer],
    ['supplier', WALLETS.supplier],
    ['attestor', WALLETS.attestor],
    ['resolver', WALLETS.resolver],
  ] as const)('recognises the %s', (role, wallet) => {
    expect(orderRolesFor(wallet, order())).toEqual([role]);
  });

  it('gives an unrelated wallet no order role', () => {
    expect(orderRolesFor(WALLETS.outsider, order())).toEqual([]);
  });

  it('gives a disconnected visitor no role', () => {
    expect(orderRolesFor(undefined, order())).toEqual([]);
    expect(orderRolesFor('', order())).toEqual([]);
  });

  it('compares addresses exactly — a case-folded look-alike is not the buyer', () => {
    expect(hasRole(WALLETS.buyer.toLowerCase(), order(), 'buyer')).toBe(false);
  });

  it('derives roles per order: one wallet can be buyer here and funder elsewhere', () => {
    const elsewhere = order({ buyer: WALLETS.outsider });
    expect(hasRole(WALLETS.buyer, order(), 'buyer')).toBe(true);
    expect(orderRolesFor(WALLETS.buyer, elsewhere)).toEqual([]);
    expect(canActAsFunder(WALLETS.buyer, elsewhere)).toBe(true);
  });

  it('never lets an order party act as its funder (contract: InvalidFunder)', () => {
    for (const wallet of [WALLETS.buyer, WALLETS.supplier, WALLETS.attestor, WALLETS.resolver]) {
      expect(canActAsFunder(wallet, order())).toBe(false);
    }
    expect(canActAsFunder(WALLETS.funder, order())).toBe(true);
    expect(canActAsFunder(undefined, order())).toBe(false);
  });

  it('shortens an address for dense UI', () => {
    expect(shortAddress(WALLETS.buyer)).toBe('GCKF…EKHW');
  });
});

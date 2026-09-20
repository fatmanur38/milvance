/**
 * Role derivation.
 *
 * A wallet's role is a FACT recorded on chain, not a choice made in the UI.
 * The order fixes buyer, supplier, attestor and resolver at creation; a funder
 * is whoever made or holds a funding position. The same wallet can be a buyer
 * on one order and a funder on another, so roles are always derived per order.
 *
 * Comparisons are exact string equality. Stellar addresses are case-sensitive
 * base32; normalising them would let a crafted look-alike match.
 *
 * None of this AUTHORIZES anything. It decides what the workspace offers to
 * show. Every action is still authorized by `require_auth` inside MilvanceCore,
 * and a wallet that is shown nothing can still not be forged into a role.
 */

export type OrderRole = 'buyer' | 'supplier' | 'attestor' | 'resolver';
export type Role = OrderRole | 'funder';

export interface OrderParties {
  readonly buyer: string;
  readonly supplier: string;
  readonly attestor: string;
  readonly resolver: string;
}

const ORDER_ROLES: readonly OrderRole[] = ['buyer', 'supplier', 'attestor', 'resolver'];

/** Roles the connected wallet holds on this order. Empty when disconnected. */
export function orderRolesFor(wallet: string | undefined, order: OrderParties): OrderRole[] {
  if (wallet === undefined || wallet === '') return [];
  return ORDER_ROLES.filter((role) => order[role] === wallet);
}

export function hasRole(wallet: string | undefined, order: OrderParties, role: OrderRole): boolean {
  return orderRolesFor(wallet, order).includes(role);
}

/**
 * Whether this wallet could fund the order at all.
 *
 * MilvanceCore rejects an offer from any of the four order parties
 * (`InvalidFunder`): a funder must be independent. Showing the offer form to a
 * party would only produce a guaranteed contract rejection.
 */
export function canActAsFunder(wallet: string | undefined, order: OrderParties): boolean {
  return wallet !== undefined && wallet !== '' && orderRolesFor(wallet, order).length === 0;
}

export const ROLE_LABELS: Record<Role, string> = {
  buyer: 'Buyer',
  supplier: 'Supplier',
  attestor: 'Attestor',
  resolver: 'Resolver',
  funder: 'Funder',
};

/** Short, readable form of a public address for dense UI. The full value stays one click away. */
export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

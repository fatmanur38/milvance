import type { Milestone, MilestoneFinance, Offer, OrderWithMilestones } from '../api/schemas';
import { canActAsFunder, hasRole } from './roles';

/**
 * Which contract actions the workspace OFFERS to the connected wallet.
 *
 * Every rule below mirrors a guard in MilvanceCore (`contracts/milvance-core`),
 * cited inline. Mirroring them keeps people from walking into guaranteed
 * rejections — but it is presentation, not permission. The contract re-checks
 * every one of these with `require_auth` and its own state guards, and a stale
 * read model can only ever cause a clean rejection, never an unauthorized act.
 *
 * Nothing here changes financial state, and nothing here is derived from a
 * "selected role" in the UI: only the connected wallet and chain-derived rows.
 */

export type OrderActionKind = 'create-milestone' | 'cancel-order' | 'accept-order';

export type MilestoneActionKind =
  | 'fund-milestone'
  | 'cancel-partial-funding'
  | 'request-finance'
  | 'cancel-finance-request'
  | 'accept-offer'
  | 'release-expired-acceptance'
  | 'make-offer'
  | 'cancel-offer'
  | 'fund-advance'
  | 'submit-evidence'
  | 'verify-milestone'
  | 'settle-milestone'
  | 'open-dispute'
  | 'resolve-dispute';

export interface MilestoneAction {
  readonly kind: MilestoneActionKind;
  /** Present when the action targets one specific offer. */
  readonly offerId?: string;
}

/** Order-level actions (`create_milestone`, `cancel_order`, `accept_order`). */
export function orderActions(
  wallet: string | undefined,
  order: OrderWithMilestones,
): OrderActionKind[] {
  const actions: OrderActionKind[] = [];
  if (order.status !== 'CREATED') return actions; // all three require OrderStatus::Created
  if (hasRole(wallet, order, 'buyer')) {
    actions.push('create-milestone', 'cancel-order'); // order.buyer.require_auth()
  }
  if (hasRole(wallet, order, 'supplier') && order.milestones.length > 0) {
    actions.push('accept-order'); // order.supplier.require_auth(); OrderHasNoMilestones otherwise
  }
  return actions;
}

function isLive(expiresAt: string, now: Date): boolean {
  // Contract: `financing::is_live` → ledger timestamp < expires_at.
  return now.getTime() < new Date(expiresAt).getTime();
}

function acceptedOffer(finance: MilestoneFinance | undefined): Offer | undefined {
  return finance?.offers.find((offer) => offer.status === 'ACCEPTED');
}

function activePositionFunder(finance: MilestoneFinance | undefined): string | undefined {
  return finance?.positions.find((position) => position.status === 'ACTIVE')?.funder;
}

/**
 * Milestone-level actions for one wallet.
 *
 * `finance` is optional: without it, financing actions that need offer or
 * request detail are simply not offered yet.
 */
export function milestoneActions(
  wallet: string | undefined,
  order: OrderWithMilestones,
  milestone: Milestone,
  finance: MilestoneFinance | undefined,
  now: Date = new Date(),
): MilestoneAction[] {
  if (wallet === undefined || wallet === '') return [];
  // Every milestone action requires OrderStatus::Active.
  if (order.status !== 'ACTIVE') return [];

  const actions: MilestoneAction[] = [];
  const isBuyer = hasRole(wallet, order, 'buyer');
  const isSupplier = hasRole(wallet, order, 'supplier');
  const status = milestone.status;
  const request = finance?.request ?? null;

  // --- Buyer: protect the milestone -------------------------------------
  if (isBuyer && status === 'UNFUNDED') {
    actions.push({ kind: 'fund-milestone' }); // fund_milestone: Unfunded only
    if (milestone.fundedAmount !== '0') {
      actions.push({ kind: 'cancel-partial-funding' }); // NoPartialFunding when zero
    }
  }

  // --- Supplier: working capital -----------------------------------------
  if (isSupplier && status === 'FUNDED' && milestone.fullyFunded) {
    actions.push({ kind: 'request-finance' }); // MilestoneNotFullyFunded otherwise
  }
  if (isSupplier && status === 'FINANCE_REQUESTED' && request?.status === 'OPEN') {
    actions.push({ kind: 'cancel-finance-request' });
    for (const offer of finance?.offers ?? []) {
      if (offer.status === 'OPEN' && isLive(offer.expiresAt, now)) {
        actions.push({ kind: 'accept-offer', offerId: offer.offerId }); // OfferExpired otherwise
      }
    }
  }
  const accepted = acceptedOffer(finance);
  if (
    isSupplier &&
    status === 'FINANCE_REQUESTED' &&
    accepted !== undefined &&
    !isLive(accepted.expiresAt, now)
  ) {
    actions.push({ kind: 'release-expired-acceptance' }); // OfferStillLive otherwise
  }

  // --- Funder: independent capital ---------------------------------------
  if (
    canActAsFunder(wallet, order) && // InvalidFunder for any order party
    status === 'FINANCE_REQUESTED' &&
    request?.status === 'OPEN' &&
    isLive(request.expiresAt, now) // FinanceRequestExpired otherwise
  ) {
    actions.push({ kind: 'make-offer' });
  }
  for (const offer of finance?.offers ?? []) {
    if (offer.funder === wallet && offer.status === 'OPEN') {
      actions.push({ kind: 'cancel-offer', offerId: offer.offerId }); // offer.funder.require_auth()
    }
  }
  if (
    accepted !== undefined &&
    accepted.funder === wallet && // accepted.funder.require_auth()
    status === 'FINANCE_REQUESTED' &&
    isLive(accepted.expiresAt, now)
  ) {
    actions.push({ kind: 'fund-advance', offerId: accepted.offerId });
  }

  // --- Evidence and verification -----------------------------------------
  if (isSupplier && (status === 'FUNDED' || status === 'FINANCED' || status === 'SUBMITTED')) {
    actions.push({ kind: 'submit-evidence' });
  }
  if (hasRole(wallet, order, 'attestor') && status === 'SUBMITTED' && milestone.evidenceHash) {
    actions.push({ kind: 'verify-milestone' }); // attestor only, Submitted only
  }

  // --- Settlement: supplier or the active position's funder --------------
  if (status === 'VERIFIED' && (isSupplier || activePositionFunder(finance) === wallet)) {
    actions.push({ kind: 'settle-milestone' });
  }

  // --- Disputes -------------------------------------------------------------
  if (
    (isBuyer || isSupplier) && // Unauthorized for anyone else
    (status === 'FUNDED' || status === 'FINANCED' || status === 'SUBMITTED')
  ) {
    actions.push({ kind: 'open-dispute' });
  }
  if (hasRole(wallet, order, 'resolver') && status === 'DISPUTED') {
    actions.push({ kind: 'resolve-dispute' });
  }

  return actions;
}

/** Actions that move USDC and therefore need a funded account with a trustline. */
export const USDC_MOVING_ACTIONS: ReadonlySet<MilestoneActionKind> = new Set([
  'fund-milestone',
  'fund-advance',
]);

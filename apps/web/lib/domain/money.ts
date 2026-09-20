import type { Milestone, MilestoneFinance } from '../api/schemas';
import { compareUnits, subtractUnits } from './amounts';

/**
 * The money on one milestone, kept in SEPARATE pools.
 *
 *   Buyer money  = protected milestone payment, held by the contract.
 *   Funder money = working capital the funder sent to the supplier.
 *
 * They come from different rows, are shown in different places, and are never
 * added together. A supplier looking at this must never read the buyer's
 * protected payment as cash they already have.
 */
export interface MoneyView {
  /** What the buyer committed to protect. */
  readonly protectedTarget: string;
  /** Buyer escrow the contract actually holds right now. Not supplier cash. */
  readonly protectedHeld: string;
  readonly fullyProtected: boolean;
  /** Funder capital already transferred funder → supplier, if any. */
  readonly advance: {
    readonly principal: string;
    readonly repayment: string;
    readonly funder: string;
    readonly status: 'ACTIVE' | 'REPAID' | 'CLOSED';
    readonly fundedTxHash: string;
  } | null;
  /** An offer the supplier accepted that the funder has not yet funded. */
  readonly pendingAdvance: {
    readonly principal: string;
    readonly repayment: string;
    readonly funder: string;
    readonly expiresAt: string;
  } | null;
  /**
   * Expected split on verification, using the contract's own waterfall:
   * funder repayment first, supplier receives the remainder. A preview only —
   * the contract computes the real figures at settlement.
   */
  readonly expectedOnVerification: {
    readonly funderRepayment: string;
    readonly supplierRemainder: string;
    /**
     * The attestor has verified the milestone, so this split is no longer a
     * future condition — it is waiting to be triggered. Presentation only: the
     * contract still computes and moves the money at settlement.
     */
    readonly awaitingSettlement: boolean;
  } | null;
  /**
   * The escrow has been released and the contract holds nothing for this
   * milestone any more — settled or refunded. What the buyer protected is
   * history at that point, and saying it is still "held on Stellar" is false.
   */
  readonly escrowReleased: boolean;
  /**
   * A dispute is open, so the resolver decides what happens next. The
   * funder-first split is only one of the two outcomes and presenting it alone
   * reads like a promise the contract has not made.
   */
  readonly awaitingResolver: boolean;
  /**
   * What the buyer had protected before release, as the chain reported it at
   * settlement or refund. Never recomputed here.
   */
  readonly originallyProtected: string | null;
  /** The waterfall as the chain actually executed it. */
  readonly settlement: MilestoneFinance['settlement'];
  readonly refund: MilestoneFinance['refund'];
}

export function moneyView(milestone: Milestone, finance: MilestoneFinance | undefined): MoneyView {
  // The latest position is the one that matters; at most one is ever ACTIVE.
  const position =
    finance?.positions.find((candidate) => candidate.status === 'ACTIVE') ??
    finance?.positions.at(-1) ??
    null;
  const accepted =
    position === null ? finance?.offers.find((offer) => offer.status === 'ACCEPTED') : undefined;

  const awaitingSettlement = milestone.status === 'VERIFIED';
  const expected =
    position !== null && position.status === 'ACTIVE'
      ? {
          funderRepayment: position.repayment,
          supplierRemainder: subtractUnits(milestone.fundedAmount, position.repayment),
          awaitingSettlement,
        }
      : milestone.fullyFunded && position === null && finance?.settlement == null
        ? { funderRepayment: '0', supplierRemainder: milestone.fundedAmount, awaitingSettlement }
        : null;

  const settlement = finance?.settlement ?? null;
  const refund = finance?.refund ?? null;

  return {
    protectedTarget: milestone.amount,
    protectedHeld: milestone.fundedAmount,
    escrowReleased: milestone.status === 'SETTLED' || milestone.status === 'REFUNDED',
    awaitingResolver: milestone.status === 'DISPUTED',
    originallyProtected: settlement?.protectedAmount ?? refund?.refundedAmount ?? null,
    fullyProtected: compareUnits(milestone.fundedAmount, milestone.amount) === 0,
    advance:
      position === null
        ? null
        : {
            principal: position.principal,
            repayment: position.repayment,
            funder: position.funder,
            status: position.status,
            fundedTxHash: position.fundedTxHash,
          },
    pendingAdvance:
      accepted === undefined
        ? null
        : {
            principal: accepted.principal,
            repayment: accepted.repayment,
            funder: accepted.funder,
            expiresAt: accepted.expiresAt,
          },
    expectedOnVerification: expected,
    settlement,
    refund,
  };
}

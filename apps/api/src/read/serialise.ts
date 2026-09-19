import type { Prisma } from '../generated/prisma/client';

/**
 * JSON shaping for chain-derived rows.
 *
 * Two rules, both load-bearing:
 *
 *   1. Every chain quantity leaves as a STRING. `u64` identifiers and `i128`
 *      amounts both exceed `Number.MAX_SAFE_INTEGER`, and a client that gets a
 *      number back has already lost precision by the time it notices.
 *   2. Every response says where the value came from, so a consumer is never
 *      invited to mistake a projection for the ledger.
 */

/** Marks a payload as derived from chain, with the provenance to verify it. */
export interface ChainDerived {
  readonly source: 'soroban-projection';
  readonly network: string;
  readonly contractId: string;
  readonly lastEventId: string;
  readonly lastLedger: string;
}

function dec(value: Prisma.Decimal): string {
  // Prisma Decimal is backed by decimal.js, not a float. `toFixed(0)` renders
  // the exact integer; `toNumber()` would be the bug this module prevents.
  return value.toFixed(0);
}

export function serialiseOrder(order: {
  orderId: bigint;
  buyer: string;
  supplier: string;
  attestor: string;
  resolver: string;
  asset: string;
  status: string;
  createdLedger: bigint;
  createdTxHash: string;
  createdAt: Date;
  network: string;
  contractId: string;
  lastEventId: string;
  lastLedger: bigint;
}) {
  return {
    orderId: order.orderId.toString(),
    buyer: order.buyer,
    supplier: order.supplier,
    attestor: order.attestor,
    resolver: order.resolver,
    settlementAsset: order.asset,
    status: order.status,
    createdLedger: order.createdLedger.toString(),
    createdTxHash: order.createdTxHash,
    createdAt: order.createdAt.toISOString(),
    provenance: {
      source: 'soroban-projection',
      network: order.network,
      contractId: order.contractId,
      lastEventId: order.lastEventId,
      lastLedger: order.lastLedger.toString(),
    } satisfies ChainDerived,
  };
}

/**
 * Operational statuses that exist only in the read model.
 *
 * AGENT.md invariant 26: DELAYED and NEEDS_REVIEW are NOT contract states. They
 * are computed here, at read time, from a deadline that has passed while the
 * milestone is not yet terminal — and computing them moves nothing. The contract
 * has no idea they exist, and a deadline passing has no financial effect
 * whatsoever (invariant 25).
 */
export type DerivedOperationalStatus = 'ON_TRACK' | 'DELAYED' | 'NEEDS_REVIEW' | 'CLOSED';

const TERMINAL: ReadonlySet<string> = new Set(['SETTLED', 'REFUNDED']);
const AWAITING_HUMAN: ReadonlySet<string> = new Set(['SUBMITTED', 'DISPUTED']);

export function derivedOperationalStatus(
  chainStatus: string,
  deadline: Date | null,
  now: Date = new Date(),
): DerivedOperationalStatus {
  if (TERMINAL.has(chainStatus)) {
    return 'CLOSED';
  }
  if (AWAITING_HUMAN.has(chainStatus)) {
    return 'NEEDS_REVIEW';
  }
  if (deadline !== null && deadline.getTime() < now.getTime()) {
    return 'DELAYED';
  }
  return 'ON_TRACK';
}

export function serialiseMilestone(
  milestone: {
    milestoneId: bigint;
    orderId: bigint;
    index: number;
    amount: Prisma.Decimal;
    fundedAmount: Prisma.Decimal;
    deadline: Date | null;
    evidenceHash: string | null;
    status: string;
    createdLedger: bigint;
    createdTxHash: string;
    createdAt: Date;
    network: string;
    contractId: string;
    lastEventId: string;
    lastLedger: bigint;
  },
  now: Date = new Date(),
) {
  return {
    milestoneId: milestone.milestoneId.toString(),
    orderId: milestone.orderId.toString(),
    index: milestone.index,
    /** Protected milestone payment the buyer commits. Exact integer string. */
    amount: dec(milestone.amount),
    /** Buyer escrow held by the contract. NOT a supplier balance. */
    fundedAmount: dec(milestone.fundedAmount),
    fullyFunded: milestone.fundedAmount.equals(milestone.amount) && milestone.amount.greaterThan(0),
    deadline: milestone.deadline?.toISOString() ?? null,
    evidenceHash: milestone.evidenceHash,
    /** Mirror of the contract's own MilestoneStatus. */
    status: milestone.status,
    /** Computed here, never stored, never able to move funds. */
    derivedStatus: derivedOperationalStatus(milestone.status, milestone.deadline, now),
    createdLedger: milestone.createdLedger.toString(),
    createdTxHash: milestone.createdTxHash,
    createdAt: milestone.createdAt.toISOString(),
    provenance: {
      source: 'soroban-projection',
      network: milestone.network,
      contractId: milestone.contractId,
      lastEventId: milestone.lastEventId,
      lastLedger: milestone.lastLedger.toString(),
    } satisfies ChainDerived,
  };
}

export function serialiseFinanceRequest(request: {
  milestoneId: bigint;
  supplier: string;
  requestedPrincipal: Prisma.Decimal;
  protectedAmount: Prisma.Decimal;
  status: string;
  expiresAt: Date;
  cancelledWhileExpired: boolean | null;
  createdAt: Date;
}) {
  return {
    milestoneId: request.milestoneId.toString(),
    supplier: request.supplier,
    requestedPrincipal: dec(request.requestedPrincipal),
    /** Buyer escrow the funder underwrites AGAINST — never draws from. */
    protectedAmount: dec(request.protectedAmount),
    status: request.status,
    expiresAt: request.expiresAt.toISOString(),
    cancelledWhileExpired: request.cancelledWhileExpired,
    createdAt: request.createdAt.toISOString(),
  };
}

export function serialiseOffer(offer: {
  offerId: bigint;
  milestoneId: bigint;
  funder: string;
  principal: Prisma.Decimal;
  repayment: Prisma.Decimal;
  status: string;
  expiresAt: Date;
  createdAt: Date;
}) {
  return {
    offerId: offer.offerId.toString(),
    milestoneId: offer.milestoneId.toString(),
    funder: offer.funder,
    principal: dec(offer.principal),
    repayment: dec(offer.repayment),
    status: offer.status,
    expiresAt: offer.expiresAt.toISOString(),
    createdAt: offer.createdAt.toISOString(),
  };
}

export function serialisePosition(position: {
  milestoneId: bigint;
  offerId: bigint;
  funder: string;
  supplier: string;
  principal: Prisma.Decimal;
  repayment: Prisma.Decimal;
  protectedAmountAtFunding: Prisma.Decimal;
  status: string;
  fundedAt: Date;
  fundedTxHash: string;
  repaidAt: Date | null;
  closedAt: Date | null;
}) {
  return {
    milestoneId: position.milestoneId.toString(),
    offerId: position.offerId.toString(),
    funder: position.funder,
    supplier: position.supplier,
    /** Moved funder -> supplier. Buyer escrow was not the source. */
    principal: dec(position.principal),
    repayment: dec(position.repayment),
    /** Buyer escrow at funding time, unchanged by the advance. */
    protectedAmountAtFunding: dec(position.protectedAmountAtFunding),
    status: position.status,
    fundedAt: position.fundedAt.toISOString(),
    fundedTxHash: position.fundedTxHash,
    repaidAt: position.repaidAt?.toISOString() ?? null,
    closedAt: position.closedAt?.toISOString() ?? null,
  };
}

export function serialiseDispute(dispute: {
  disputeId: bigint;
  milestoneId: bigint;
  openedBy: string;
  resolver: string;
  status: string;
  openedAt: Date;
  openedTxHash: string;
  resolvedAt: Date | null;
  resolvedTxHash: string | null;
}) {
  return {
    disputeId: dispute.disputeId.toString(),
    milestoneId: dispute.milestoneId.toString(),
    openedBy: dispute.openedBy,
    resolver: dispute.resolver,
    status: dispute.status,
    openedAt: dispute.openedAt.toISOString(),
    openedTxHash: dispute.openedTxHash,
    resolvedAt: dispute.resolvedAt?.toISOString() ?? null,
    resolvedTxHash: dispute.resolvedTxHash,
  };
}

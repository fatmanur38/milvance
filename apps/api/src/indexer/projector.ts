import type { Prisma, PrismaClient } from '../generated/prisma/client';
import { assertNonNegativeI128, assertU64, ledgerTimeToDate, toBigInt } from '../common/amounts';
import type { DecodedEvent, MilvanceEventName } from './decoder';

/**
 * Projects contract events onto the PostgreSQL read models.
 *
 * WHAT THIS IS NOT: a second financial state machine. Nothing here decides what
 * *should* happen — the contract already decided, and these functions only copy
 * the outcome it published. There is no validation that invents a transition, no
 * branch that settles a milestone because a date passed, and no path that writes
 * a financial column from anything other than an event the chain emitted.
 *
 * Two properties make replay safe:
 *
 *   - every write is an upsert keyed on the chain identifier, so re-running the
 *     same event produces the same row rather than a second one;
 *   - every row records `lastEventId`, and an event whose id is not greater than
 *     the stored one is skipped, so re-delivering an older event cannot roll a
 *     row backwards.
 *
 * Both are needed. The unique constraints stop duplicates; the monotonic guard
 * stops out-of-order regressions.
 */

/** The transactional client the indexer hands to each projection. */
export type ProjectionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'
>;

export interface ProjectionContext {
  readonly network: string;
  readonly contractId: string;
}

function str(fields: Readonly<Record<string, unknown>>, key: string): string {
  const value = fields[key];
  if (typeof value !== 'string') {
    throw new Error(`Event field ${key} is not an address/string`);
  }
  return value;
}

function u64(fields: Readonly<Record<string, unknown>>, key: string): bigint {
  return assertU64(toBigInt(fields[key]), key);
}

function i128(fields: Readonly<Record<string, unknown>>, key: string): bigint {
  return assertNonNegativeI128(toBigInt(fields[key]), key);
}

/**
 * `u32` is the one chain integer that is safe as a JavaScript number: its
 * maximum is far below `Number.MAX_SAFE_INTEGER`. Milestone `index` is the only
 * field that uses it. Every other integer stays a bigint.
 */
function u32(fields: Readonly<Record<string, unknown>>, key: string): number {
  const value = fields[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`Event field ${key} is not a u32`);
  }
  return value;
}

function bool(fields: Readonly<Record<string, unknown>>, key: string): boolean {
  const value = fields[key];
  if (typeof value !== 'boolean') {
    throw new Error(`Event field ${key} is not a bool`);
  }
  return value;
}

function hex32(fields: Readonly<Record<string, unknown>>, key: string): string {
  const value = fields[key];
  const hex =
    value instanceof Uint8Array ? Buffer.from(value).toString('hex') : String(value).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(`Event field ${key} is not a 32-byte digest`);
  }
  return hex;
}

/** Optional `u64` deadline: absent, or a unix second count. */
function optionalDeadline(fields: Readonly<Record<string, unknown>>): Date | null {
  const value = fields.deadline;
  if (value === undefined || value === null) {
    return null;
  }
  return ledgerTimeToDate(assertU64(toBigInt(value), 'deadline'));
}

/** A row is only moved forward. Older or repeated events are no-ops. */
function isNewer(existingEventId: string | undefined, incoming: string): boolean {
  return existingEventId === undefined || incoming > existingEventId;
}

interface Stamp {
  lastEventId: string;
  lastLedger: bigint;
}

function stamp(event: DecodedEvent): Stamp {
  return { lastEventId: event.eventId, lastLedger: event.ledger };
}

async function findOrder(db: ProjectionClient, ctx: ProjectionContext, orderId: bigint) {
  return db.orderReadModel.findUnique({
    where: { order_identity: { network: ctx.network, contractId: ctx.contractId, orderId } },
  });
}

async function requireMilestone(db: ProjectionClient, ctx: ProjectionContext, milestoneId: bigint) {
  const milestone = await db.milestoneReadModel.findUnique({
    where: {
      milestone_identity: { network: ctx.network, contractId: ctx.contractId, milestoneId },
    },
  });
  if (milestone === null) {
    // Backfill always starts at the contract's first ledger, so a milestone
    // event without its `milestone_created` means the stream was started too
    // late. Failing here keeps the cursor parked rather than writing a row with
    // invented `amount` and `orderId`.
    throw new Error(
      `milestone ${milestoneId.toString()} has no projection; replay from the contract's first ledger`,
    );
  }
  return milestone;
}

/**
 * Apply one event.
 *
 * Returns `true` when the event produced a projection, `false` when it was
 * recognised but deliberately ignored (an unknown event, or one already applied).
 * Throws on anything it cannot honestly project — the caller then rolls the
 * whole batch back and leaves the cursor where it was.
 */
export async function projectEvent(
  db: ProjectionClient,
  ctx: ProjectionContext,
  event: DecodedEvent,
): Promise<boolean> {
  if (!event.known) {
    return false;
  }
  if (!event.successful) {
    // Events from a reverted call are recorded for auditability but describe
    // state the chain never adopted.
    return false;
  }

  const f = event.fields;
  const base = { network: ctx.network, contractId: ctx.contractId };
  // `known` was established by `isMilvanceEventName`, so this narrowing is
  // sound. It is what lets the compiler prove every event has a case below.
  const name = event.eventName as MilvanceEventName;

  switch (name) {
    case 'order_created': {
      const orderId = u64(f, 'order_id');
      const existing = await findOrder(db, ctx, orderId);
      if (existing !== null) {
        return false; // creation is idempotent by definition
      }
      await db.orderReadModel.create({
        data: {
          ...base,
          orderId,
          buyer: str(f, 'buyer'),
          supplier: str(f, 'supplier'),
          attestor: str(f, 'attestor'),
          resolver: str(f, 'resolver'),
          asset: str(f, 'asset'),
          status: 'CREATED',
          createdLedger: event.ledger,
          createdTxHash: event.txHash,
          createdAt: event.ledgerClosedAt,
          ...stamp(event),
        },
      });
      return true;
    }

    case 'order_accepted':
    case 'order_cancelled':
    case 'order_completed': {
      const orderId = u64(f, 'order_id');
      const order = await findOrder(db, ctx, orderId);
      if (order === null) {
        throw new Error(
          `order ${orderId.toString()} has no projection; replay from the contract's first ledger`,
        );
      }
      if (!isNewer(order.lastEventId, event.eventId)) {
        return false;
      }
      const status =
        event.eventName === 'order_accepted'
          ? 'ACTIVE'
          : event.eventName === 'order_cancelled'
            ? 'CANCELLED'
            : 'COMPLETED';
      await db.orderReadModel.update({
        where: { id: order.id },
        data: { status, ...stamp(event) },
      });
      return true;
    }

    case 'milestone_created': {
      const orderId = u64(f, 'order_id');
      const milestoneId = u64(f, 'milestone_id');
      const order = await findOrder(db, ctx, orderId);
      if (order === null) {
        throw new Error(
          `milestone ${milestoneId.toString()} references unprojected order ${orderId.toString()}`,
        );
      }
      const index = u32(f, 'index');
      await db.milestoneReadModel.upsert({
        where: {
          milestone_identity: { ...base, milestoneId },
        },
        create: {
          ...base,
          milestoneId,
          orderId,
          orderRowId: order.id,
          index,
          amount: i128(f, 'amount').toString(),
          fundedAmount: '0',
          deadline: optionalDeadline(f),
          status: 'UNFUNDED',
          createdLedger: event.ledger,
          createdTxHash: event.txHash,
          createdAt: event.ledgerClosedAt,
          ...stamp(event),
        },
        update: {},
      });
      return true;
    }

    case 'milestone_funded': {
      const milestoneId = u64(f, 'milestone_id');
      const milestone = await requireMilestone(db, ctx, milestoneId);
      if (!isNewer(milestone.lastEventId, event.eventId)) {
        return false;
      }
      // `funded_amount` is the contract's cumulative total, not a delta to add.
      // Copying it verbatim is what keeps the read model incapable of drifting
      // upward through double application.
      const fundedAmount = i128(f, 'funded_amount');
      await db.milestoneReadModel.update({
        where: { id: milestone.id },
        data: {
          fundedAmount: fundedAmount.toString(),
          status: bool(f, 'fully_funded') ? 'FUNDED' : 'UNFUNDED',
          ...stamp(event),
        },
      });
      return true;
    }

    case 'partial_funding_cancelled': {
      const milestoneId = u64(f, 'milestone_id');
      const milestone = await requireMilestone(db, ctx, milestoneId);
      if (!isNewer(milestone.lastEventId, event.eventId)) {
        return false;
      }
      await db.milestoneReadModel.update({
        where: { id: milestone.id },
        data: { fundedAmount: '0', status: 'UNFUNDED', ...stamp(event) },
      });
      return true;
    }

    case 'finance_requested': {
      const milestoneId = u64(f, 'milestone_id');
      const milestone = await requireMilestone(db, ctx, milestoneId);
      const expiresAt = ledgerTimeToDate(u64(f, 'expires_at'));
      if (expiresAt === null) {
        throw new Error('finance_requested carried no expiry');
      }
      const existingRequest = await db.financeRequestReadModel.findUnique({
        where: { finance_request_identity: { ...base, milestoneId } },
      });
      const requestFields = {
        supplier: str(f, 'supplier'),
        requestedPrincipal: i128(f, 'requested_principal').toString(),
        protectedAmount: i128(f, 'protected_amount').toString(),
        status: 'OPEN' as const,
        expiresAt,
      };
      if (existingRequest === null) {
        await db.financeRequestReadModel.create({
          data: {
            ...base,
            milestoneId,
            milestoneRowId: milestone.id,
            ...requestFields,
            createdLedger: event.ledger,
            createdTxHash: event.txHash,
            createdAt: event.ledgerClosedAt,
            ...stamp(event),
          },
        });
      } else if (isNewer(existingRequest.lastEventId, event.eventId)) {
        // A milestone may seek financing again after an earlier request was
        // cancelled or released. The chain reuses the same one-per-milestone
        // slot, so the projection does too.
        await db.financeRequestReadModel.update({
          where: { id: existingRequest.id },
          data: { ...requestFields, cancelledWhileExpired: null, ...stamp(event) },
        });
      }
      if (isNewer(milestone.lastEventId, event.eventId)) {
        await db.milestoneReadModel.update({
          where: { id: milestone.id },
          data: { status: 'FINANCE_REQUESTED', ...stamp(event) },
        });
      }
      return true;
    }

    case 'finance_request_cancelled': {
      const milestoneId = u64(f, 'milestone_id');
      const milestone = await requireMilestone(db, ctx, milestoneId);
      const request = await db.financeRequestReadModel.findUnique({
        where: { finance_request_identity: { ...base, milestoneId } },
      });
      if (request === null) {
        throw new Error(
          `finance request for milestone ${milestoneId.toString()} has no projection`,
        );
      }
      if (isNewer(request.lastEventId, event.eventId)) {
        await db.financeRequestReadModel.update({
          where: { id: request.id },
          data: {
            status: 'CANCELLED',
            cancelledWhileExpired: bool(f, 'was_expired'),
            ...stamp(event),
          },
        });
      }
      if (isNewer(milestone.lastEventId, event.eventId)) {
        // The milestone is still fully protected — it simply stopped seeking
        // financing. No escrow moved.
        await db.milestoneReadModel.update({
          where: { id: milestone.id },
          data: { status: 'FUNDED', ...stamp(event) },
        });
      }
      return true;
    }

    case 'funding_offer_created': {
      const milestoneId = u64(f, 'milestone_id');
      const offerId = u64(f, 'offer_id');
      const milestone = await requireMilestone(db, ctx, milestoneId);
      const expiresAt = ledgerTimeToDate(u64(f, 'expires_at'));
      if (expiresAt === null) {
        throw new Error('funding_offer_created carried no expiry');
      }
      await db.fundingOfferReadModel.upsert({
        where: { offer_identity: { ...base, offerId } },
        create: {
          ...base,
          offerId,
          milestoneId,
          milestoneRowId: milestone.id,
          funder: str(f, 'funder'),
          principal: i128(f, 'principal').toString(),
          repayment: i128(f, 'repayment').toString(),
          status: 'OPEN',
          expiresAt,
          createdLedger: event.ledger,
          createdTxHash: event.txHash,
          createdAt: event.ledgerClosedAt,
          ...stamp(event),
        },
        update: {},
      });
      return true;
    }

    case 'funding_offer_cancelled':
    case 'offer_accepted': {
      const offerId = u64(f, 'offer_id');
      const offer = await db.fundingOfferReadModel.findUnique({
        where: { offer_identity: { ...base, offerId } },
      });
      if (offer === null) {
        throw new Error(`funding offer ${offerId.toString()} has no projection`);
      }
      if (!isNewer(offer.lastEventId, event.eventId)) {
        return false;
      }
      await db.fundingOfferReadModel.update({
        where: { id: offer.id },
        data: {
          status: event.eventName === 'offer_accepted' ? 'ACCEPTED' : 'CANCELLED',
          ...stamp(event),
        },
      });
      if (event.eventName === 'offer_accepted') {
        const request = await db.financeRequestReadModel.findUnique({
          where: {
            finance_request_identity: { ...base, milestoneId: u64(f, 'milestone_id') },
          },
        });
        if (request === null) {
          throw new Error(
            `finance request for accepted offer ${offerId.toString()} has no projection`,
          );
        }
        if (isNewer(request.lastEventId, event.eventId)) {
          await db.financeRequestReadModel.update({
            where: { id: request.id },
            data: { status: 'ACCEPTED', ...stamp(event) },
          });
        }
      }
      return true;
    }

    case 'advance_funded': {
      const milestoneId = u64(f, 'milestone_id');
      const offerId = u64(f, 'offer_id');
      const milestone = await requireMilestone(db, ctx, milestoneId);

      // The principal came from the FUNDER'S wallet to the SUPPLIER. Buyer
      // escrow is deliberately not touched here — `fundedAmount` is not in this
      // update, and `protectedAmountAtFunding` records what escrow held so the
      // separation stays visible in the read model.
      await db.financePositionReadModel.upsert({
        where: { position_identity: { ...base, milestoneId, offerId } },
        create: {
          ...base,
          milestoneId,
          offerId,
          milestoneRowId: milestone.id,
          funder: str(f, 'funder'),
          supplier: str(f, 'supplier'),
          principal: i128(f, 'principal').toString(),
          repayment: i128(f, 'repayment').toString(),
          protectedAmountAtFunding: i128(f, 'protected_amount').toString(),
          status: 'ACTIVE',
          fundedLedger: event.ledger,
          fundedTxHash: event.txHash,
          fundedAt: event.ledgerClosedAt,
          ...stamp(event),
        },
        update: {},
      });
      const fundedOffer = await db.fundingOfferReadModel.updateMany({
        where: { ...base, offerId },
        data: { status: 'FUNDED', ...stamp(event) },
      });
      if (fundedOffer.count !== 1) {
        throw new Error(`funded offer ${offerId.toString()} has no projection`);
      }
      if (isNewer(milestone.lastEventId, event.eventId)) {
        await db.milestoneReadModel.update({
          where: { id: milestone.id },
          data: { status: 'FINANCED', ...stamp(event) },
        });
      }
      return true;
    }

    case 'acceptance_released': {
      const milestoneId = u64(f, 'milestone_id');
      const offerId = u64(f, 'offer_id');
      const milestone = await requireMilestone(db, ctx, milestoneId);
      const reopened = bool(f, 'request_reopened');

      // No value moved: the selected funder never advanced capital.
      const releasedOffer = await db.fundingOfferReadModel.updateMany({
        where: { ...base, offerId },
        data: { status: 'CANCELLED', ...stamp(event) },
      });
      if (releasedOffer.count !== 1) {
        throw new Error(`released offer ${offerId.toString()} has no projection`);
      }
      const request = await db.financeRequestReadModel.findUnique({
        where: { finance_request_identity: { ...base, milestoneId } },
      });
      if (request === null) {
        throw new Error(
          `finance request for released offer ${offerId.toString()} has no projection`,
        );
      }
      if (isNewer(request.lastEventId, event.eventId)) {
        await db.financeRequestReadModel.update({
          where: { id: request.id },
          data: { status: reopened ? 'OPEN' : 'CANCELLED', ...stamp(event) },
        });
      }
      if (isNewer(milestone.lastEventId, event.eventId)) {
        await db.milestoneReadModel.update({
          where: { id: milestone.id },
          data: { status: reopened ? 'FINANCE_REQUESTED' : 'FUNDED', ...stamp(event) },
        });
      }
      return true;
    }

    case 'evidence_submitted': {
      const milestoneId = u64(f, 'milestone_id');
      const milestone = await requireMilestone(db, ctx, milestoneId);
      const digest = hex32(f, 'evidence_hash');
      if (isNewer(milestone.lastEventId, event.eventId)) {
        await db.milestoneReadModel.update({
          where: { id: milestone.id },
          data: { evidenceHash: digest, status: 'SUBMITTED', ...stamp(event) },
        });
      }
      const anchor = await db.evidenceAnchorReadModel.findUnique({
        where: { evidence_anchor_identity: { ...base, milestoneId } },
      });
      if (anchor === null) {
        await db.evidenceAnchorReadModel.create({
          data: {
            ...base,
            milestoneId,
            milestoneRowId: milestone.id,
            contentHash: digest,
            submittedLedger: event.ledger,
            submittedTxHash: event.txHash,
            submittedAt: event.ledgerClosedAt,
            lastEventId: event.eventId,
          },
        });
      } else if (isNewer(anchor.lastEventId, event.eventId)) {
        await db.evidenceAnchorReadModel.update({
          where: { id: anchor.id },
          data: {
            contentHash: digest,
            submittedLedger: event.ledger,
            submittedTxHash: event.txHash,
            submittedAt: event.ledgerClosedAt,
            lastEventId: event.eventId,
          },
        });
      }
      // If the document was uploaded through this backend, mark the metadata row
      // as ever anchored. The current milestone link is the separate row above.
      await db.evidenceObject.updateMany({
        where: { ...base, contentHash: digest },
        data: {
          anchoredOnChain: true,
          anchoredAt: event.ledgerClosedAt,
          anchoredTxHash: event.txHash,
        },
      });
      return true;
    }

    case 'milestone_verified': {
      const milestoneId = u64(f, 'milestone_id');
      const milestone = await requireMilestone(db, ctx, milestoneId);
      if (!isNewer(milestone.lastEventId, event.eventId)) {
        return false;
      }
      await db.milestoneReadModel.update({
        where: { id: milestone.id },
        data: { evidenceHash: hex32(f, 'evidence_hash'), status: 'VERIFIED', ...stamp(event) },
      });
      return true;
    }

    case 'milestone_settled': {
      const milestoneId = u64(f, 'milestone_id');
      const orderId = u64(f, 'order_id');
      const milestone = await requireMilestone(db, ctx, milestoneId);
      const funderRepayment = i128(f, 'funder_repayment');

      await db.settlementReadModel.upsert({
        where: { settlement_identity: { ...base, milestoneId } },
        create: {
          ...base,
          milestoneId,
          orderId,
          protectedAmount: i128(f, 'protected_amount').toString(),
          funderRepayment: funderRepayment.toString(),
          supplierPayout: i128(f, 'supplier_payout').toString(),
          settledLedger: event.ledger,
          settledTxHash: event.txHash,
          settledAt: event.ledgerClosedAt,
          lastEventId: event.eventId,
        },
        update: {},
      });
      if (isNewer(milestone.lastEventId, event.eventId)) {
        await db.milestoneReadModel.update({
          where: { id: milestone.id },
          data: { status: 'SETTLED', ...stamp(event) },
        });
      }
      if (funderRepayment > 0n) {
        const repaid = await db.financePositionReadModel.updateMany({
          where: { ...base, milestoneId, status: 'ACTIVE' },
          data: { status: 'REPAID', repaidAt: event.ledgerClosedAt, ...stamp(event) },
        });
        if (repaid.count !== 1) {
          throw new Error(
            `settlement for milestone ${milestoneId.toString()} has no active finance position`,
          );
        }
      }
      return true;
    }

    case 'milestone_refunded': {
      const milestoneId = u64(f, 'milestone_id');
      const milestone = await requireMilestone(db, ctx, milestoneId);
      await db.refundReadModel.upsert({
        where: { refund_identity: { ...base, milestoneId } },
        create: {
          ...base,
          milestoneId,
          orderId: u64(f, 'order_id'),
          buyer: str(f, 'buyer'),
          refundedAmount: i128(f, 'refunded_amount').toString(),
          funderAdvanceOutstanding: i128(f, 'funder_advance_outstanding').toString(),
          refundedLedger: event.ledger,
          refundedTxHash: event.txHash,
          refundedAt: event.ledgerClosedAt,
          lastEventId: event.eventId,
        },
        update: {},
      });
      if (isNewer(milestone.lastEventId, event.eventId)) {
        await db.milestoneReadModel.update({
          where: { id: milestone.id },
          data: { status: 'REFUNDED', ...stamp(event) },
        });
      }
      // The refund did NOT claw back the funder's advance. The position closes
      // without escrow repayment; the supplier keeps the principal.
      //
      // The contract reports `funder_advance_outstanding` as the principal of
      // the ACTIVE position it closed, and 0 when there was none (principal is
      // always > 0). The projection must agree exactly: closing zero rows for a
      // financed refund, or finding a live position the chain says did not
      // exist, both mean the read model has diverged — fail closed.
      const outstanding = i128(f, 'funder_advance_outstanding');
      const closed = await db.financePositionReadModel.updateMany({
        where: { ...base, milestoneId, status: 'ACTIVE' },
        data: { status: 'CLOSED', closedAt: event.ledgerClosedAt, ...stamp(event) },
      });
      const expectedClosed = outstanding > 0n ? 1 : 0;
      if (closed.count !== expectedClosed) {
        throw new Error(
          `refund for milestone ${milestoneId.toString()} closed ${closed.count} active finance position(s); chain implies ${expectedClosed}`,
        );
      }
      return true;
    }

    case 'dispute_opened': {
      const milestoneId = u64(f, 'milestone_id');
      const disputeId = u64(f, 'dispute_id');
      const milestone = await requireMilestone(db, ctx, milestoneId);
      await db.disputeReadModel.upsert({
        where: { dispute_identity: { ...base, disputeId } },
        create: {
          ...base,
          disputeId,
          milestoneId,
          milestoneRowId: milestone.id,
          openedBy: str(f, 'opened_by'),
          resolver: str(f, 'resolver'),
          status: 'OPEN',
          openedLedger: event.ledger,
          openedTxHash: event.txHash,
          openedAt: event.ledgerClosedAt,
          ...stamp(event),
        },
        update: {},
      });
      if (isNewer(milestone.lastEventId, event.eventId)) {
        await db.milestoneReadModel.update({
          where: { id: milestone.id },
          data: { status: 'DISPUTED', ...stamp(event) },
        });
      }
      return true;
    }

    case 'dispute_resolved': {
      const disputeId = u64(f, 'dispute_id');
      const settled = bool(f, 'settled');
      const dispute = await db.disputeReadModel.findUnique({
        where: { dispute_identity: { ...base, disputeId } },
      });
      if (dispute === null) {
        throw new Error(`dispute ${disputeId.toString()} has no projection`);
      }
      if (!isNewer(dispute.lastEventId, event.eventId)) {
        return false;
      }
      await db.disputeReadModel.update({
        where: { id: dispute.id },
        data: {
          status: settled ? 'RESOLVED_SETTLE' : 'RESOLVED_REFUND',
          resolvedAt: event.ledgerClosedAt,
          resolvedTxHash: event.txHash,
          ...stamp(event),
        },
      });
      // A SETTLE resolution returns the milestone to VERIFIED. The actual payout
      // is a separate `milestone_settled` / `milestone_refunded` event; this one
      // moves no money.
      const milestone = await requireMilestone(db, ctx, dispute.milestoneId);
      if (settled && isNewer(milestone.lastEventId, event.eventId)) {
        await db.milestoneReadModel.update({
          where: { id: milestone.id },
          data: { status: 'VERIFIED', ...stamp(event) },
        });
      }
      return true;
    }

    default: {
      // Unreachable by construction: every name in MILVANCE_EVENT_NAMES has a
      // case above, and adding a name without a case fails to compile here.
      // Throwing (rather than returning false) keeps it fail-closed even if a
      // cast ever lies to the compiler.
      const unhandled: never = name;
      throw new Error(`no projection for known event ${String(unhandled)}`);
    }
  }
}

/** Data written for the raw event log. Public-safe by construction. */
export function eventLogRow(
  ctx: ProjectionContext,
  event: DecodedEvent,
  payload: Prisma.InputJsonValue,
  projected: boolean,
) {
  return {
    network: ctx.network,
    contractId: ctx.contractId,
    eventId: event.eventId,
    ledger: event.ledger,
    txHash: event.txHash,
    eventIndex: event.eventIndex,
    txIndex: event.txIndex,
    operationIndex: event.operationIndex,
    eventName: event.eventName,
    successful: event.successful,
    ledgerClosedAt: event.ledgerClosedAt,
    payload,
    topicsXdr: [...event.topicsXdr],
    valueXdr: event.valueXdr,
    projected,
  };
}

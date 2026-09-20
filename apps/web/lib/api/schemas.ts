import { z } from 'zod';

/**
 * Runtime contracts for every API response the workspace reads.
 *
 * The API is our own, but it is still a network boundary: a stale deployment,
 * a proxy error page or a half-migrated database can all return something that
 * type-checks as `any`. Every response is validated here before a component
 * sees it, and a mismatch surfaces as an explicit error rather than a blank or,
 * worse, a wrong number.
 *
 * Amounts and chain ids stay STRINGS. They are i128 / u64 values and are only
 * ever turned into `bigint`, never into a JavaScript number.
 */

const integerString = z.string().regex(/^-?\d+$/, 'expected an integer string');
const account = z.string().regex(/^G[A-Z2-7]{55}$/, 'expected a Stellar account');
const contract = z.string().regex(/^C[A-Z2-7]{55}$/, 'expected a Stellar contract');
const digest = z.string().regex(/^[0-9a-f]{64}$/, 'expected a SHA-256 digest');
const txHash = z.string().regex(/^[0-9a-f]{64}$/i, 'expected a transaction hash');
const isoDate = z.string().min(1);

export const ORDER_STATUSES = ['CREATED', 'ACTIVE', 'COMPLETED', 'CANCELLED'] as const;
export const MILESTONE_STATUSES = [
  'UNFUNDED',
  'FUNDED',
  'FINANCE_REQUESTED',
  'FINANCED',
  'SUBMITTED',
  'VERIFIED',
  'DISPUTED',
  'SETTLED',
  'REFUNDED',
] as const;
export const DERIVED_STATUSES = ['ON_TRACK', 'DELAYED', 'NEEDS_REVIEW', 'CLOSED'] as const;

export const provenanceSchema = z.object({
  source: z.literal('soroban-projection'),
  network: z.string(),
  contractId: contract,
  lastEventId: z.string(),
  lastLedger: integerString,
});

export const orderSchema = z.object({
  orderId: integerString,
  buyer: account,
  supplier: account,
  attestor: account,
  resolver: account,
  settlementAsset: contract,
  status: z.enum(ORDER_STATUSES),
  createdLedger: integerString,
  createdTxHash: txHash,
  createdAt: isoDate,
  provenance: provenanceSchema,
});

export const milestoneSchema = z.object({
  milestoneId: integerString,
  orderId: integerString,
  index: z.number().int().nonnegative(),
  amount: integerString,
  fundedAmount: integerString,
  fullyFunded: z.boolean(),
  deadline: isoDate.nullable(),
  evidenceHash: digest.nullable(),
  status: z.enum(MILESTONE_STATUSES),
  derivedStatus: z.enum(DERIVED_STATUSES),
  createdLedger: integerString,
  createdTxHash: txHash,
  createdAt: isoDate,
  provenance: provenanceSchema,
});

export const orderWithMilestonesSchema = orderSchema.extend({
  milestones: z.array(milestoneSchema),
});

export const orderListSchema = z.object({
  orders: z.array(orderWithMilestonesSchema),
  count: z.number().int().nonnegative(),
});

export const financeRequestSchema = z.object({
  milestoneId: integerString,
  supplier: account,
  requestedPrincipal: integerString,
  protectedAmount: integerString,
  status: z.enum(['OPEN', 'ACCEPTED', 'CANCELLED']),
  expiresAt: isoDate,
  cancelledWhileExpired: z.boolean().nullable(),
  createdAt: isoDate,
});

export const offerSchema = z.object({
  offerId: integerString,
  milestoneId: integerString,
  funder: account,
  principal: integerString,
  repayment: integerString,
  status: z.enum(['OPEN', 'CANCELLED', 'ACCEPTED', 'FUNDED']),
  expiresAt: isoDate,
  createdAt: isoDate,
});

export const positionSchema = z.object({
  milestoneId: integerString,
  offerId: integerString,
  funder: account,
  supplier: account,
  principal: integerString,
  repayment: integerString,
  protectedAmountAtFunding: integerString,
  status: z.enum(['ACTIVE', 'REPAID', 'CLOSED']),
  fundedAt: isoDate,
  fundedTxHash: txHash,
  repaidAt: isoDate.nullable(),
  closedAt: isoDate.nullable(),
});

export const disputeSchema = z.object({
  disputeId: integerString,
  milestoneId: integerString,
  openedBy: account,
  resolver: account,
  status: z.enum(['OPEN', 'RESOLVED_SETTLE', 'RESOLVED_REFUND']),
  openedAt: isoDate,
  openedTxHash: txHash,
  resolvedAt: isoDate.nullable(),
  resolvedTxHash: txHash.nullable(),
});

export const milestoneFinanceSchema = z.object({
  milestoneId: integerString,
  /** Buyer money held by the contract. NOT supplier cash. */
  buyerProtectedEscrow: integerString,
  /** Funder capital already sent to the supplier. A different pool. */
  funderAdvance: integerString,
  request: financeRequestSchema.nullable(),
  offers: z.array(offerSchema),
  positions: z.array(positionSchema),
  /** The waterfall exactly as `milestone_settled` reported it. */
  settlement: z
    .object({
      protectedAmount: integerString,
      funderRepayment: integerString,
      supplierPayout: integerString,
      settledAt: isoDate,
      settledTxHash: txHash,
    })
    .nullable(),
  /** The refund exactly as `milestone_refunded` reported it. */
  refund: z
    .object({
      refundedAmount: integerString,
      funderAdvanceOutstanding: integerString,
      refundedAt: isoDate,
      refundedTxHash: txHash,
    })
    .nullable(),
});

export const evidenceDocumentSchema = z.object({
  contentHash: digest,
  filename: z.string(),
  mimeType: z.string(),
  byteSize: integerString,
  documentLabel: z.string().nullable(),
  uploadedBy: account.nullable(),
  anchoredOnChain: z.boolean(),
  anchoredTxHash: txHash.nullable(),
  createdAt: isoDate,
});

export const milestoneEvidenceSchema = z.object({
  milestoneId: integerString,
  onChainEvidenceHash: digest.nullable(),
  documents: z.array(evidenceDocumentSchema),
});

export const milestoneDisputesSchema = z.object({
  milestoneId: integerString,
  disputes: z.array(disputeSchema),
});

export const opportunitiesSchema = z.object({
  opportunities: z.array(
    financeRequestSchema.extend({ milestone: milestoneSchema, order: orderSchema }),
  ),
});

export const funderOffersSchema = z.object({
  offers: z.array(
    offerSchema.extend({
      milestone: milestoneSchema,
      order: orderSchema,
      request: financeRequestSchema.nullable(),
    }),
  ),
});

export const positionsSchema = z.object({ positions: z.array(positionSchema) });

export const activitySchema = z.object({
  activity: z.array(
    z.object({
      eventId: z.string(),
      eventName: z.string(),
      ledger: integerString,
      txHash: txHash,
      ledgerClosedAt: isoDate,
      projected: z.boolean(),
      fields: z.unknown(),
    }),
  ),
});

const checkSchema = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  detail: z.string().optional(),
});

export const readinessSchema = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  checks: z.object({ database: checkSchema, rpc: checkSchema, indexer: checkSchema }),
  time: isoDate,
});

export const indexerStatusSchema = z.object({
  scannedThroughLedger: integerString.nullable(),
  chainHead: integerString.nullable(),
  ledgersBehind: integerString.nullable(),
  lastError: z.string().nullable(),
  unprojectedSuccessfulEvents: z.number().int().nonnegative(),
});

export const evidenceUploadSchema = z.object({
  contentHash: digest,
  byteSize: integerString,
  filename: z.string(),
  mimeType: z.string(),
  documentLabel: z.string().nullable(),
  anchoredOnChain: z.boolean(),
});

export type Order = z.infer<typeof orderSchema>;
export type Milestone = z.infer<typeof milestoneSchema>;
export type OrderWithMilestones = z.infer<typeof orderWithMilestonesSchema>;
export type FinanceRequest = z.infer<typeof financeRequestSchema>;
export type Offer = z.infer<typeof offerSchema>;
export type Position = z.infer<typeof positionSchema>;
export type Dispute = z.infer<typeof disputeSchema>;
export type MilestoneFinance = z.infer<typeof milestoneFinanceSchema>;
export type MilestoneEvidence = z.infer<typeof milestoneEvidenceSchema>;
export type Opportunity = z.infer<typeof opportunitiesSchema>['opportunities'][number];
export type FunderOffer = z.infer<typeof funderOffersSchema>['offers'][number];
export type Readiness = z.infer<typeof readinessSchema>;
export type IndexerStatus = z.infer<typeof indexerStatusSchema>;
export type ActivityItem = z.infer<typeof activitySchema>['activity'][number];
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export type DerivedStatus = (typeof DERIVED_STATUSES)[number];

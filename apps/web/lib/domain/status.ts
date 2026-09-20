import type { DerivedStatus, MilestoneStatus, OrderStatus } from '../api/schemas';

/**
 * Product language for contract states.
 *
 * The labels describe what a status MEANS for the people in the deal. The
 * contract enum name stays available for technical detail views.
 */
export const MILESTONE_STATUS_LABELS: Record<MilestoneStatus, string> = {
  UNFUNDED: 'Awaiting protection',
  FUNDED: 'Protected by buyer',
  FINANCE_REQUESTED: 'Working capital requested',
  FINANCED: 'Advance received',
  SUBMITTED: 'Evidence submitted',
  VERIFIED: 'Verified',
  DISPUTED: 'In dispute',
  SETTLED: 'Payment complete',
  REFUNDED: 'Refunded to buyer',
};

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  CREATED: 'Awaiting supplier',
  ACTIVE: 'In production',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

/**
 * Operational hints computed by the read model from deadlines and review
 * states. They are NOT contract states and they move no money: a deadline
 * passing can never settle, refund or transfer anything on its own.
 */
export const DERIVED_STATUS_LABELS: Record<DerivedStatus, string | null> = {
  ON_TRACK: null,
  CLOSED: null,
  DELAYED: 'Past target date',
  NEEDS_REVIEW: 'Needs review',
};

export type Tone = 'neutral' | 'progress' | 'attention' | 'success' | 'danger';

export const MILESTONE_TONE: Record<MilestoneStatus, Tone> = {
  UNFUNDED: 'neutral',
  FUNDED: 'progress',
  FINANCE_REQUESTED: 'progress',
  FINANCED: 'progress',
  SUBMITTED: 'attention',
  VERIFIED: 'progress',
  DISPUTED: 'danger',
  SETTLED: 'success',
  REFUNDED: 'neutral',
};

/** The financed path, in order, for the milestone progress stepper. */
export const MILESTONE_PATH: readonly MilestoneStatus[] = [
  'UNFUNDED',
  'FUNDED',
  'FINANCE_REQUESTED',
  'FINANCED',
  'SUBMITTED',
  'VERIFIED',
  'SETTLED',
];

/** Milestones are generic on chain; the product numbers them for people. */
export function milestoneTitle(index: number): string {
  return `Milestone ${index + 1}`;
}

/** A partially funded milestone is still UNFUNDED on chain; say what that means. */
export function milestoneStatusLabel(status: MilestoneStatus, fundedAmount: string): string {
  if (status === 'UNFUNDED' && fundedAmount !== '0') return 'Partially protected';
  return MILESTONE_STATUS_LABELS[status];
}

const EVENT_LABELS: Record<string, string> = {
  order_created: 'Order created',
  order_accepted: 'Supplier accepted the order',
  order_cancelled: 'Order cancelled',
  order_completed: 'Order completed',
  milestone_created: 'Milestone added',
  milestone_funded: 'Buyer protected milestone money',
  partial_funding_cancelled: 'Partial protection returned to buyer',
  finance_requested: 'Supplier requested working capital',
  finance_request_cancelled: 'Working capital request closed',
  funding_offer_created: 'Funder made an offer',
  funding_offer_cancelled: 'Funder withdrew an offer',
  offer_accepted: 'Supplier chose a funding offer',
  advance_funded: 'Funder advanced working capital',
  acceptance_released: 'Unfunded offer released',
  evidence_submitted: 'Supplier submitted evidence',
  milestone_verified: 'Attestor verified the milestone',
  milestone_settled: 'Milestone payment completed',
  milestone_refunded: 'Milestone refunded to buyer',
  dispute_opened: 'Dispute opened',
  dispute_resolved: 'Dispute resolved',
};

export function eventLabel(eventName: string): string {
  return EVENT_LABELS[eventName] ?? eventName.replaceAll('_', ' ');
}

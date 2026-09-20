import type { ActivityItem, OrderWithMilestones } from '../api/schemas';

/**
 * The guided tour: a narrated replay of a trade that really happened.
 *
 * This is NOT a simulation and it is deliberately incapable of becoming one.
 * Every step below is built from an indexed MilvanceCore event — the same
 * events the workspace and the metrics read — and carries the real transaction
 * hash that produced it. There is no scripted state, no placeholder amount and
 * no step that can appear without a transaction on Stellar behind it.
 *
 * It exists because a judge with no wallet, no Testnet XLM and four minutes
 * still deserves to see what the product does. They read history; anyone who
 * wants to make new history connects a wallet and uses the real workspace.
 */

/** Which economic idea a step demonstrates. Drives the emphasis in the UI. */
export type TourTheme =
  | 'setup'
  | 'buyer-protection'
  | 'working-capital'
  | 'local-money'
  | 'verification'
  | 'settlement'
  | 'dispute';

export interface TourStep {
  /** Event id: unique, and already the indexer's own ordering key. */
  readonly id: string;
  readonly theme: TourTheme;
  readonly title: string;
  /** What happened, in words a non-engineer can check against the hash. */
  readonly detail: string;
  /** Who acted, by role rather than by address. */
  readonly actor: string;
  /** Exact USDC base units this step moved or committed, when it moved any. */
  readonly amount: string | null;
  /** How that amount should be read — the two pools stay distinguishable. */
  readonly amountMeans: 'protected' | 'advanced' | 'repaid' | 'paid-out' | 'refunded' | null;
  readonly txHash: string;
  readonly ledger: string;
  readonly at: string;
  /** The point a judge should take away. Omitted where there is nothing to add. */
  readonly lesson?: string;
}

interface EventFields {
  readonly order_id?: unknown;
  readonly milestone_id?: unknown;
  readonly amount?: unknown;
  readonly principal?: unknown;
  readonly repayment?: unknown;
  readonly requested_principal?: unknown;
  readonly protected_amount?: unknown;
  readonly funder_repayment?: unknown;
  readonly supplier_payout?: unknown;
  readonly refunded_amount?: unknown;
  readonly funder_advance_outstanding?: unknown;
  readonly fully_funded?: unknown;
  readonly evidence_hash?: unknown;
  readonly settled?: unknown;
}

function fieldsOf(item: ActivityItem): EventFields {
  return (
    typeof item.fields === 'object' && item.fields !== null ? item.fields : {}
  ) as EventFields;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Narration for one event.
 *
 * Returns `null` for events that are real but add nothing to the story — a
 * tour that lists every internal transition is a log, not an explanation.
 */
function narrate(item: ActivityItem): Omit<TourStep, 'id' | 'txHash' | 'ledger' | 'at'> | null {
  const f = fieldsOf(item);

  switch (item.eventName) {
    case 'order_created':
      return {
        theme: 'setup',
        title: 'A buyer opens a trade',
        detail:
          'The buyer names the supplier, and the two people who will settle any disagreement: an attestor who checks the work, and a resolver who decides a dispute. Those addresses are fixed for the life of the order.',
        actor: 'Buyer',
        amount: null,
        amountMeans: null,
        lesson:
          'Choosing the attestor and resolver up front is the real security decision. The contract enforces who decides — it cannot judge the work itself.',
      };
    case 'milestone_created':
      return {
        theme: 'setup',
        title: 'A payment stage is defined',
        detail:
          'Work is broken into stages that are paid separately. Each one carries its own money and its own outcome.',
        actor: 'Buyer',
        amount: text(f.amount),
        amountMeans: null,
      };
    case 'order_accepted':
      return {
        theme: 'setup',
        title: 'The supplier accepts',
        detail: 'Both sides are now committed to the same terms, recorded on Stellar.',
        actor: 'Supplier',
        amount: null,
        amountMeans: null,
      };
    case 'milestone_funded':
      return {
        theme: 'buyer-protection',
        title: 'The buyer protects the payment',
        detail:
          'The money leaves the buyer and is held by the contract against this stage. It is committed and visible, and nobody can spend it — not the supplier, not the buyer, not Milvance.',
        actor: 'Buyer',
        amount: text(f.amount),
        amountMeans: 'protected',
        lesson:
          'This is the difference between protecting a payment and prepaying a supplier. The buyer has not paid anyone yet.',
      };
    case 'finance_requested':
      return {
        theme: 'working-capital',
        title: 'The supplier asks for working capital',
        detail:
          'A protected milestone is a promise about the future, and a factory cannot pay wages with a promise. The supplier asks to borrow against it — never more than the amount protected.',
        actor: 'Supplier',
        amount: text(f.requested_principal),
        amountMeans: null,
      };
    case 'funding_offer_created':
      return {
        theme: 'working-capital',
        title: 'A funder makes an offer',
        detail:
          'An independent funder offers cash now against repayment later. The contract refuses any funder who is the buyer, supplier, attestor or resolver of this trade.',
        actor: 'Funder',
        amount: text(f.principal),
        amountMeans: null,
      };
    case 'offer_accepted':
      return {
        theme: 'working-capital',
        title: 'The supplier picks an offer',
        detail: 'Accepting fixes the repayment the escrow will owe this funder first.',
        actor: 'Supplier',
        amount: text(f.repayment),
        amountMeans: null,
      };
    case 'advance_funded':
      return {
        theme: 'working-capital',
        title: 'The funder pays the supplier, now',
        detail:
          'The funder moves their own USDC straight to the supplier. The buyer’s protected money has not moved and does not move here.',
        actor: 'Funder',
        amount: text(f.principal),
        amountMeans: 'advanced',
        lesson:
          'Two separate pools of money, from two different people. If the advance came out of escrow, the buyer would be prepaying after all — just with extra steps.',
      };
    case 'evidence_submitted':
      return {
        theme: 'verification',
        title: 'The supplier submits evidence',
        detail:
          'The document itself stays off-chain. Thirty-two bytes — its SHA-256 fingerprint — go on Stellar, signed by the supplier’s own wallet.',
        actor: 'Supplier',
        amount: null,
        amountMeans: null,
        lesson:
          'This proves the attestor read exactly the file that was committed, unaltered. It does not prove the file is honest, and Milvance does not claim it does.',
      };
    case 'milestone_verified':
      return {
        theme: 'verification',
        title: 'The attestor verifies the work',
        detail:
          'The named attestor compares the evidence with what was promised and records the decision on chain. Only that address can.',
        actor: 'Attestor',
        amount: null,
        amountMeans: null,
      };
    case 'milestone_settled':
      return {
        theme: 'settlement',
        title: 'The contract settles, funder first',
        detail:
          'One atomic transaction: the funder is repaid out of the protected money, and the supplier receives what is left. No one chooses the order — the contract enforces it.',
        actor: 'Contract',
        amount: text(f.protected_amount),
        amountMeans: 'repaid',
        lesson:
          'The funder’s advance is not paid again here. They advanced their own money earlier and are now made whole out of escrow.',
      };
    case 'dispute_opened':
      return {
        theme: 'dispute',
        title: 'A stage is disputed',
        detail:
          'Disputes are per stage. This one freezes its own milestone and leaves every other stage of the order exactly where it was.',
        actor: 'Buyer',
        amount: null,
        amountMeans: null,
      };
    case 'milestone_refunded':
      return {
        theme: 'dispute',
        title: 'The resolver refunds the buyer',
        detail:
          'The named resolver decided in the buyer’s favour, and the protected money went back to the buyer.',
        actor: 'Resolver',
        amount: text(f.refunded_amount),
        amountMeans: 'refunded',
        lesson:
          text(f.funder_advance_outstanding) !== null && f.funder_advance_outstanding !== '0'
            ? 'A refund does not claw back a funder’s advance. The supplier keeps it, and the funder’s remaining claim is off-chain — that is the risk a funder is really taking.'
            : 'This stage was never financed, so no funder was affected by the refund.',
      };
    case 'dispute_resolved':
      return {
        theme: 'dispute',
        title: 'The dispute closes',
        detail:
          f.settled === true
            ? 'Resolved in the supplier’s favour: the milestone returns to verified and can settle.'
            : 'Resolved as a refund. The decision is final and the stage is closed.',
        actor: 'Resolver',
        amount: null,
        amountMeans: null,
      };
    case 'order_completed':
      return {
        theme: 'settlement',
        title: 'Every stage is finished',
        detail:
          'All milestones reached a final state, so the order closed itself. The contract is holding nothing for this trade.',
        actor: 'Contract',
        amount: null,
        amountMeans: null,
      };
    default:
      // Real, indexed, and not part of the story. Listing every internal
      // transition would turn an explanation back into a log.
      return null;
  }
}

/** Events that belong to one order, including those keyed only by milestone. */
function belongsTo(
  item: ActivityItem,
  orderId: string,
  milestoneIds: ReadonlySet<string>,
): boolean {
  const f = fieldsOf(item);
  if (text(f.order_id) === orderId) return true;
  const milestone = text(f.milestone_id);
  return milestone !== null && milestoneIds.has(milestone);
}

/**
 * Builds the tour for one order from the indexed event feed.
 *
 * Ordered oldest first, because it is a story. Events the projector recorded
 * but did not project are excluded: an unprojected event is one the read model
 * does not stand behind, and it has no business narrating anything.
 */
export function buildTour(
  order: OrderWithMilestones,
  activity: readonly ActivityItem[],
): readonly TourStep[] {
  const milestoneIds = new Set(order.milestones.map((milestone) => milestone.milestoneId));
  const steps: TourStep[] = [];

  for (const item of [...activity].reverse()) {
    if (!item.projected) continue;
    if (!belongsTo(item, order.orderId, milestoneIds)) continue;
    const narration = narrate(item);
    if (narration === null) continue;
    steps.push({
      ...narration,
      id: item.eventId,
      txHash: item.txHash,
      ledger: item.ledger,
      at: item.ledgerClosedAt,
    });
  }
  return steps;
}

/**
 * Which order the tour should show.
 *
 * A finished trade tells the whole story, so a COMPLETED order wins; otherwise
 * the one that got furthest. Derived rather than hardcoded, so the tour keeps
 * working on a fresh deployment whose history is not ours.
 */
export function pickTourOrder(orders: readonly OrderWithMilestones[]): OrderWithMilestones | null {
  if (orders.length === 0) return null;
  const rank = (order: OrderWithMilestones): number =>
    order.status === 'COMPLETED' ? 3 : order.status === 'ACTIVE' ? 2 : 1;
  return [...orders].sort((left, right) => {
    const byRank = rank(right) - rank(left);
    if (byRank !== 0) return byRank;
    // Newest first within a rank: BigInt, because these are u64 chain ids.
    return BigInt(right.orderId) > BigInt(left.orderId) ? 1 : -1;
  })[0]!;
}

/** Whether the tour has enough real history to be worth showing. */
export function tourIsTellable(steps: readonly TourStep[]): boolean {
  // Anything less than a protected milestone is a trade that has not started,
  // and narrating it would promise a story the chain cannot tell yet.
  return steps.some((step) => step.amountMeans === 'protected');
}

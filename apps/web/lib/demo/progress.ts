import type { MilestoneFinance, OrderWithMilestones } from '../api/schemas';

/**
 * Demo progress, derived from chain-projected state only.
 *
 * Every step below is a question answered by the read model — which is itself a
 * projection of MilvanceCore events. Nothing here is a checkbox a person can
 * tick, and nothing is remembered locally: reload the page, clear the browser,
 * open it on someone else's laptop, and the same trade shows the same progress,
 * because the progress IS the chain state.
 *
 * A step is `done` when the chain says it happened, `now` when it is the next
 * thing that must happen, and `later` otherwise. A trade that ends in a refund
 * marks the settlement step `skipped`, because that money went back to the
 * buyer instead — pretending otherwise would be a lie about where funds went.
 */

export type StepState = 'done' | 'now' | 'later' | 'skipped';

export interface DemoStep {
  readonly id: string;
  readonly label: string;
  /** Who acts, in plain words. */
  readonly who: string;
  readonly state: StepState;
}

export interface DemoProgress {
  readonly steps: readonly DemoStep[];
  readonly done: number;
  readonly total: number;
  /** True once the order itself is finished on chain. */
  readonly complete: boolean;
}

/**
 * Progress for one milestone of a trade.
 *
 * `finance` may be undefined while the query is still loading; the steps then
 * simply stay `later`, which is honest — we do not yet know.
 */
export function demoProgress(
  order: OrderWithMilestones,
  milestoneIndex: number,
  finance: MilestoneFinance | undefined,
): DemoProgress {
  const milestone = order.milestones[milestoneIndex];
  const status = milestone?.status ?? null;
  const terminal = status === 'SETTLED' || status === 'REFUNDED';
  const refunded = status === 'REFUNDED';

  const created = true;
  const accepted = order.status !== 'CREATED';
  const protectedFully = milestone?.fullyFunded === true || reached(status, 'FUNDED');
  const requested = finance?.request != null || reached(status, 'FINANCE_REQUESTED');
  const offered = (finance?.offers.length ?? 0) > 0;
  const chosen =
    finance?.offers.some((offer) => offer.status === 'ACCEPTED' || offer.status === 'FUNDED') ===
    true;
  const advanced = (finance?.positions.length ?? 0) > 0 || reached(status, 'FINANCED');
  const evidenced = milestone?.evidenceHash != null || reached(status, 'SUBMITTED');
  const verified = reached(status, 'VERIFIED');
  const settled = status === 'SETTLED' || finance?.settlement != null;

  const raw: readonly Omit<DemoStep, 'state'>[] = [
    { id: 'created', label: 'Trade created', who: 'Buyer' },
    { id: 'accepted', label: 'Supplier accepted', who: 'Supplier' },
    { id: 'protected', label: 'Buyer protected the milestone', who: 'Buyer' },
    { id: 'requested', label: 'Working capital requested', who: 'Supplier' },
    { id: 'offered', label: 'Funding offer received', who: 'Funder' },
    { id: 'chosen', label: 'Offer chosen', who: 'Supplier' },
    { id: 'advanced', label: 'Advance received', who: 'Funder' },
    { id: 'evidenced', label: 'Evidence submitted', who: 'Supplier' },
    { id: 'verified', label: 'Milestone verified', who: 'Attestor' },
    { id: 'settled', label: 'Settled — funder repaid first', who: 'Supplier or funder' },
  ];

  // What the chain has actually recorded, before any reasoning about it.
  const observed = [
    created,
    accepted,
    protectedFully,
    requested,
    offered,
    chosen,
    advanced,
    evidenced,
    verified,
    settled,
  ];

  // The contract's own ordering fills in what must have happened. A milestone
  // cannot be verified without evidence, and an advance cannot exist without an
  // offer that was made and chosen — so a late signal proves the earlier ones,
  // even when a settled milestone's escrow now reads zero.
  const CORE = [0, 1, 2, 7, 8, 9];
  const FINANCING = [3, 4, 5, 6];
  const imply = (chain: readonly number[]): void => {
    for (let i = chain.length - 1; i > 0; i -= 1) {
      const later = chain[i] as number;
      const earlier = chain[i - 1] as number;
      if (observed[later] === true) observed[earlier] = true;
    }
  };
  imply(CORE);
  imply(FINANCING);
  if (observed[6] === true) observed[2] = true; // an advance needs a protected milestone

  // Financing is optional. A milestone that has moved past it without a request
  // or a position was simply never financed: those steps did not happen and
  // never will, so they are shown as skipped rather than as pending work.
  const pastFinancing = evidenced || verified || terminal || status === 'DISPUTED';
  const financingSkipped = pastFinancing && !requested && !advanced;

  const skipped = raw.map((_step, index) => {
    if (observed[index] === true) return false;
    if (refunded) return true; // the money went back; nothing else will happen
    return financingSkipped && FINANCING.includes(index);
  });

  const nextIndex = raw.findIndex(
    (_step, index) => observed[index] !== true && skipped[index] !== true,
  );

  const steps = raw.map((step, index) => ({
    ...step,
    state: (observed[index] === true
      ? 'done'
      : skipped[index] === true
        ? 'skipped'
        : index === nextIndex
          ? 'now'
          : 'later') as StepState,
  }));

  const done = observed.filter(Boolean).length;
  return {
    steps,
    done,
    total: steps.length,
    complete: order.status === 'COMPLETED' || (terminal && order.status !== 'ACTIVE'),
  };
}

/**
 * Whether a milestone's status implies an earlier one was already passed.
 *
 * The contract's happy path is ordered, so a milestone in `VERIFIED` certainly
 * was funded — even if a later refund or settlement has since emptied the
 * escrow and a naive "is it funded right now" check would say no.
 */
const ORDERED_STATUSES = [
  'UNFUNDED',
  'FUNDED',
  'FINANCE_REQUESTED',
  'FINANCED',
  'SUBMITTED',
  'VERIFIED',
] as const;

function reached(status: string | null, target: (typeof ORDERED_STATUSES)[number]): boolean {
  if (status === null) return false;
  // Terminal states sit past the whole ordered path.
  if (status === 'SETTLED') return true;
  if (status === 'REFUNDED' || status === 'DISPUTED') {
    // A dispute or refund proves protection happened, but says nothing about
    // financing or evidence beyond what the other signals already show.
    return target === 'FUNDED';
  }
  const at = ORDERED_STATUSES.indexOf(status as (typeof ORDERED_STATUSES)[number]);
  const want = ORDERED_STATUSES.indexOf(target);
  return at >= 0 && want >= 0 && at >= want;
}

export interface NextAction {
  /** What to do, addressed to the connected wallet. */
  readonly label: string;
  /** Where the real, wallet-signed control lives. */
  readonly href: string;
}

/**
 * The next thing THIS wallet can do, or null.
 *
 * Presentation only, and deliberately thin: it points at the existing workspace
 * controls rather than building another way to sign. Whether the action is
 * actually permitted is decided by `milestoneActions`/`orderActions` (which
 * mirror the contract) and then by MilvanceCore itself.
 */
export function nextActionHref(orderId: string, milestoneId: string | null): string {
  return milestoneId === null
    ? `/app/orders/${orderId}`
    : `/app/orders/${orderId}#milestone-${milestoneId}`;
}

import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}


export const networks = {
  testnet: {
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: "CCN6AZHLN2BQPCDZWXJGA3NRJEJ56V5JK3M4VZ5QFKQ3NSJBN6RVTKRX",
  }
} as const


/**
 * A commercial order between one buyer and one supplier.
 *
 * Every address field is assigned at creation and immutable afterwards: no
 * function in this contract mutates `buyer`, `supplier`, `attestor`, `resolver`
 * or `asset`. This is what makes "only the assigned attestor can verify"
 * (invariant 14) and "order asset is immutable" (invariant 19) enforceable.
 */
export interface Order {
  /**
 * Settlement asset, snapshotted from `Config.usdc` at creation.
 */
asset: string;
  /**
 * Authorized to verify milestone evidence (PKG-04).
 */
attestor: string;
  /**
 * Prefunds protected milestone escrow. Never the supplier's working capital.
 */
buyer: string;
  created_at: u64;
  id: u64;
  /**
 * Authorized to resolve a disputed milestone (PKG-04).
 */
resolver: string;
  status: OrderStatus;
  supplier: string;
}


/**
 * Global protocol configuration (instance storage).
 *
 * `admin` is an operational role only. Per AGENT.md §19 invariant 17 the admin
 * has **no** authority to move, withdraw or redirect user funds, and no function
 * in this contract grants it any. It exists to identify the deploying operator.
 */
export interface Config {
  admin: string;
  protocol_version: u32;
  /**
 * Settlement asset contract (USDC SAC). MVP rejects any other asset.
 */
usdc: string;
}


/**
 * A dispute over exactly one milestone.
 *
 * Disputes are milestone-scoped so that freezing M4 cannot disturb already
 * settled M1–M3 (AGENT.md §9A.5).
 *
 * Declared in PKG-01; created and mutated in PKG-04.
 */
export interface Dispute {
  id: u64;
  milestone_id: u64;
  opened_at: u64;
  opened_by: string;
  resolver: string;
  status: DisputeStatus;
}


/**
 * A single protected production milestone.
 *
 * The contract is intentionally generic: there is no label, carrier, port,
 * vessel or Bill of Lading field. A milestone meaning "QC + Handed to Carrier"
 * or "Delivery Confirmed" is labelled off-chain (AGENT.md §9A, §20). That keeps
 * the same state machine usable for raw materials, production, QC, shipment and
 * delivery without the contract knowing what a ship is.
 */
export interface Milestone {
  /**
 * Protected milestone payment the buyer commits to escrow, in asset units.
 */
amount: i128;
  created_at: u64;
  /**
 * Informational target date. Expiry alone must never move funds
 * (invariant 25); it can only surface a derived status off-chain.
 */
deadline: Option<u64>;
  /**
 * SHA-256 commitment to the off-chain evidence for this milestone.
 *
 * Only the digest lives on chain. Raw documents — bills of lading, QC
 * reports, packing lists, delivery confirmations — stay off-chain, and the
 * contract attaches no meaning to what the digest covers.
 */
evidence_hash: Option<Buffer>;
  /**
 * Buyer escrow actually received so far. Mutated only by PKG-02.
 *
 * This is **buyer money held by the contract**, never a supplier balance.
 */
funded_amount: i128;
  id: u64;
  /**
 * Position within the order, assigned in creation order.
 */
index: u32;
  order_id: u64;
  status: MilestoneStatus;
}

export enum OfferStatus {
  Open = 0,
  Cancelled = 1,
  Accepted = 2,
  Funded = 3,
}

/**
 * Order lifecycle (AGENT.md §17).
 *
 * ```text
 * CREATED → ACTIVE → COMPLETED
 * └───→ CANCELLED
 * ```
 *
 * `Completed` is reached only when every milestone is terminal. That transition
 * depends on settlement and is therefore implemented in PKG-04, not here.
 */
export enum OrderStatus {
  Created = 0,
  Active = 1,
  Completed = 2,
  Cancelled = 3,
}


/**
 * A competing funder's priced offer. Held in temporary storage while open
 * (AGENT.md §18); accepted economics are copied into a persistent
 * `FinancePosition` at funding time so they can never change afterwards.
 *
 * Declared in PKG-01; created and mutated in PKG-03.
 */
export interface FundingOffer {
  expires_at: u64;
  funder: string;
  id: u64;
  milestone_id: u64;
  /**
 * Advanced to the supplier from the funder's own capital.
 */
principal: i128;
  /**
 * Repaid to the funder first out of verified milestone escrow.
 */
repayment: i128;
  status: OfferStatus;
}

/**
 * Dispute lifecycle. The resolution is encoded in the terminal status rather
 * than stored separately, so a resolved dispute can never carry a missing or
 * contradictory outcome.
 */
export enum DisputeStatus {
  Open = 0,
  ResolvedSettle = 1,
  ResolvedRefund = 2,
}


/**
 * A supplier's request for working capital against a fully protected milestone.
 *
 * Declared in PKG-01; created and mutated in PKG-03.
 */
export interface FinanceRequest {
  created_at: u64;
  expires_at: u64;
  milestone_id: u64;
  requested_principal: i128;
  status: FinanceRequestStatus;
  supplier: string;
}


/**
 * The single active repayment position for a milestone.
 *
 * At most one `Active` position may exist per milestone (invariant 1). The
 * principal recorded here was transferred **funder → supplier** from the
 * funder's own capital; it is never drawn from buyer escrow (invariant 24).
 *
 * Declared in PKG-01; created and mutated in PKG-03 / PKG-04.
 */
export interface FinancePosition {
  funded_at: u64;
  funder: string;
  milestone_id: u64;
  offer_id: u64;
  principal: i128;
  repayment: i128;
  status: FinancePositionStatus;
  supplier: string;
}

/**
 * Milestone lifecycle (AGENT.md §17).
 *
 * ```text
 * financed:   UNFUNDED → FUNDED → FINANCE_REQUESTED → FINANCED
 * → SUBMITTED → VERIFIED → SETTLED
 * unfinanced: UNFUNDED → FUNDED → SUBMITTED → VERIFIED → SETTLED
 * dispute:    FUNDED | FINANCED | SUBMITTED → DISPUTED → VERIFIED | REFUNDED
 * ```
 *
 * The full vocabulary is defined here so later packages cannot invent states.
 * PKG-01 only ever produces `Unfunded`.
 *
 * `DELAYED` / `NEEDS_REVIEW` are deliberately **absent**: per invariant 26 they
 * are derived read-model/UI statuses and must never become contract state.
 */
export enum MilestoneStatus {
  Unfunded = 0,
  Funded = 1,
  FinanceRequested = 2,
  Financed = 3,
  Submitted = 4,
  Verified = 5,
  Disputed = 6,
  Settled = 7,
  Refunded = 8,
}

/**
 * Resolution chosen by the assigned resolver, used as the `resolve_dispute`
 * parameter in PKG-04. Partial settlement is explicitly out of scope (§8).
 */
export enum DisputeResolution {
  Settle = 0,
  Refund = 1,
}

export enum FinanceRequestStatus {
  Open = 0,
  Accepted = 1,
  Cancelled = 2,
}

/**
 * Lifecycle of a funder's repayment position.
 *
 * `Closed` means the position ended **without** repayment from milestone
 * escrow — the refund path. The funder's advance is not clawed back and the
 * supplier keeps it; whatever claim the funder retains against the supplier is
 * an off-chain matter this contract does not model.
 */
export enum FinancePositionStatus {
  Active = 0,
  Repaid = 1,
  Closed = 2,
}

/**
 * Explicit, stable error codes for `MilvanceCore`.
 *
 * Codes are part of the contract surface: never renumber an existing variant,
 * only append. Off-chain clients (PKG-05 bindings, PKG-08 indexer, PKG-09 UI)
 * map these to user-facing messages.
 */
export const Errors = {
  1: {message:"NotInitialized"},
  2: {message:"Unauthorized"},
  10: {message:"OrderNotFound"},
  11: {message:"MilestoneNotFound"},
  20: {message:"InvalidOrderStatus"},
  21: {message:"InvalidMilestoneStatus"},
  22: {message:"OrderHasNoMilestones"},
  30: {message:"InvalidParties"},
  31: {message:"InvalidAttestor"},
  32: {message:"InvalidResolver"},
  33: {message:"InvalidAmount"},
  34: {message:"InvalidDeadline"},
  35: {message:"MilestoneLimitReached"},
  36: {message:"AttestorResolverConflict"},
  /**
   * The asset supplied by the caller is not this order's settlement asset.
   */
  40: {message:"InvalidAsset"},
  /**
   * The deposit would push escrow past the protected milestone amount.
   */
  41: {message:"Overfunded"},
  /**
   * A release would exceed the escrow this milestone actually holds.
   */
  42: {message:"InsufficientEscrow"},
  43: {message:"ArithmeticOverflow"},
  50: {message:"FinanceRequestNotFound"},
  /**
   * A live finance request already exists for this milestone.
   */
  51: {message:"FinanceRequestActive"},
  52: {message:"FinanceRequestExpired"},
  53: {message:"InvalidFinanceRequestStatus"},
  /**
   * The milestone does not hold its full protected amount, so it is not
   * financeable (invariant 23).
   */
  54: {message:"MilestoneNotFullyFunded"},
  55: {message:"OfferNotFound"},
  56: {message:"InvalidOfferStatus"},
  57: {message:"OfferExpired"},
  /**
   * Offers must match the requested principal exactly, so competing offers
   * differ only in repayment.
   */
  58: {message:"PrincipalMismatch"},
  /**
   * `repayment < principal`.
   */
  59: {message:"InvalidRepayment"},
  /**
   * `repayment > funded milestone amount` (invariant 2).
   */
  60: {message:"RepaymentExceedsEscrow"},
  61: {message:"OfferLimitReached"},
  /**
   * The funder must be independent of buyer, supplier, attestor and resolver.
   */
  62: {message:"InvalidFunder"},
  63: {message:"NoAcceptedOffer"},
  /**
   * An ACTIVE FinancePosition already exists for this milestone (invariant 1).
   */
  64: {message:"AlreadyFinanced"},
  65: {message:"FinancePositionNotFound"},
  /**
   * An expiry timestamp is in the past or beyond the allowed window.
   */
  66: {message:"InvalidExpiry"},
  /**
   * Defensive: the funder advance altered buyer milestone escrow. This must
   * be unreachable; reaching it reverts the whole invocation.
   */
  67: {message:"EscrowMutated"},
  /**
   * The accepted offer has not expired yet, so it cannot be released.
   */
  68: {message:"OfferStillLive"},
  /**
   * No evidence has been committed for this milestone.
   */
  70: {message:"EvidenceNotFound"},
  /**
   * The attestor signed for a different digest than the one on record.
   */
  71: {message:"EvidenceMismatch"},
  /**
   * An all-zero digest is rejected as an unset sentinel.
   */
  72: {message:"InvalidEvidence"},
  73: {message:"DisputeNotFound"},
  74: {message:"DisputeAlreadyOpen"},
  75: {message:"InvalidDisputeStatus"},
  /**
   * The milestone holds no escrow to pay out or return.
   */
  76: {message:"NothingToSettle"},
  /**
   * The milestone holds no partial escrow to unwind.
   */
  77: {message:"NoPartialFunding"},
  /**
   * An offer has already been selected, so the request cannot be cancelled.
   */
  78: {message:"OfferAlreadyAccepted"}
}





















export interface Client {
  /**
   * Construct and simulate a get_offer transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * A single offer by id. Errors if its temporary entry is gone.
   */
  get_offer: ({offer_id}: {offer_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<FundingOffer>>>

  /**
   * Construct and simulate a get_order transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_order: ({order_id}: {order_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Order>>>

  /**
   * Construct and simulate a get_config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_config: (options?: MethodOptions) => Promise<AssembledTransaction<Result<Config>>>

  /**
   * Construct and simulate a make_offer transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * A funder prices an open finance request.
   *
   * Authorized by the **funder**, who must be independent of buyer,
   * supplier, attestor and resolver.
   *
   * `principal` must equal the requested principal exactly, so competing
   * offers differ only in `repayment` and the supplier's comparison is
   * unambiguous. `repayment` must be at least `principal` and at most the
   * protected milestone escrow (invariants 3, 4, 2).
   *
   * Making an offer commits no capital. The transfer happens in
   * [`Self::fund_advance`], from the funder's own wallet.
   *
   * Offers live in temporary storage; their economics become permanent only
   * when the supplier accepts.
   */
  make_offer: ({milestone_id, funder, principal, repayment, expires_at}: {milestone_id: u64, funder: string, principal: i128, repayment: i128, expires_at: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a offer_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Number of funding offers created so far, across all milestones.
   */
  offer_count: (options?: MethodOptions) => Promise<AssembledTransaction<u64>>

  /**
   * Construct and simulate a order_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Number of orders created so far; also the id of the most recent order.
   */
  order_count: (options?: MethodOptions) => Promise<AssembledTransaction<u64>>

  /**
   * Construct and simulate a accept_offer transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Supplier selects exactly one offer.
   *
   * Authorized by the **supplier** of the milestone's order.
   *
   * The selected offer is copied into persistent storage here. That copy —
   * not the temporary offer entry — is what [`Self::fund_advance`] reads, so
   * the accepted economics survive the temporary entry's expiry and cannot
   * be altered afterwards (invariant 7).
   *
   * Only one offer may be accepted per milestone: the request moves to
   * `Accepted`, which rejects any further acceptance.
   */
  accept_offer: ({offer_id}: {offer_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a accept_order transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Supplier accepts the order, moving it `Created → Active`.
   *
   * Authorized by the **assigned supplier** only; the address is read from
   * the stored order rather than taken as a parameter, so no other account
   * can accept on their behalf.
   *
   * An order with no milestones cannot be accepted: there would be nothing to
   * commit to.
   */
  accept_order: ({order_id}: {order_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a cancel_offer transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * A funder withdraws an offer that has not been accepted.
   *
   * Authorized by the **offer's own funder**. An accepted or funded offer
   * cannot be cancelled: its economics are already locked.
   */
  cancel_offer: ({offer_id}: {offer_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a cancel_order transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Buyer cancels an order that the supplier has not yet accepted.
   *
   * Restricted to `Created`, which is the only status in which no milestone
   * can hold escrow. Cancelling an `Active` order would require unwinding
   * escrow and any finance position, which is dispute/refund territory
   * (PKG-04) and is deliberately not available here.
   */
  cancel_order: ({order_id}: {order_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a create_order transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Creates an order in `Created` and returns its id.
   *
   * Authorized by the **buyer**. The settlement asset is snapshotted from
   * protocol config rather than accepted as a parameter, so an order can
   * never be created against a non-USDC asset (invariant 20) and can never
   * have its asset changed afterwards (invariant 19).
   *
   * Attestor and resolver must be third parties: allowing the buyer or
   * supplier to attest their own milestone would defeat the verification
   * model that settlement depends on. They must also differ from each other,
   * so that a disputed verification is never reviewed by its own author.
   */
  create_order: ({buyer, supplier, attestor, resolver}: {buyer: string, supplier: string, attestor: string, resolver: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a fund_advance transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The selected funder advances working capital to the supplier.
   *
   * **This moves the funder's own capital, funder wallet → supplier wallet.**
   * Buyer milestone escrow is not the source, is not debited, and
   * `funded_amount` is not written by this call. The buyer's protected
   * amount is read only as the ceiling that repayment was validated against.
   *
   * Authorized by the **accepted offer's funder**, read from persistent
   * state, so no other account can fund in their place.
   *
   * Atomic within one invocation: validate accepted offer → validate expiry
   * → validate milestone state → validate no active position → require
   * funder auth → transfer principal → persist `FinancePosition` →
   * transition milestone → emit. Any failure reverts all of it, so an
   * `Active` position can never exist without its transfer having happened.
   */
  fund_advance: ({milestone_id}: {milestone_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a open_dispute transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Buyer or supplier freezes a single milestone for review.
   *
   * Only this milestone is affected. Sibling milestones keep their own
   * escrow, financing and terminal states untouched (AGENT.md §9A.5), which
   * is what lets a delivery dispute on M4 leave settled M1-M3 alone.
   *
   * A passed deadline is **not** a reason this function fires on its own.
   * Nothing in this contract reacts to a deadline; a party has to open a
   * dispute deliberately (invariants 25, 26).
   */
  open_dispute: ({milestone_id, caller}: {milestone_id: u64, caller: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a dispute_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  dispute_count: (options?: MethodOptions) => Promise<AssembledTransaction<u64>>

  /**
   * Construct and simulate a get_milestone transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_milestone: ({milestone_id}: {milestone_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Milestone>>>

  /**
   * Construct and simulate a fund_milestone transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Buyer deposits protected milestone payment into contract escrow.
   *
   * Returns the milestone's cumulative `funded_amount` after this deposit.
   *
   * **This is buyer protection, not supplier working capital.** The money
   * moves buyer → contract and stays under contract control. Nothing in this
   * package can pay it to the supplier, and the supplier's early liquidity
   * comes from a funder's own capital in PKG-03, never from here.
   *
   * Authorized by the **buyer** of the milestone's order, read from stored
   * state rather than a parameter.
   *
   * The order must be `Active`: money is only committed to a scope the
   * supplier has accepted. This also keeps `cancel_order` (which is
   * `Created`-only) permanently disjoint from any funded milestone.
   *
   * `asset` must equal the order's settlement asset. It is a required
   * parameter so a client holding a stale or wrong asset id fails loudly
   * instead of silently transferring the right one.
   *
   * Partial deposits are allowed and accumulate. The milestone only reaches
   * `Funded` — and therefore only becomes financeable
   */
  fund_milestone: ({milestone_id, amount, asset}: {milestone_id: u64, amount: i128, asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a get_open_offers transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Offers on a milestone that are still open and still live.
   *
   * Resolves each indexed id and skips entries that are missing, cancelled,
   * accepted, funded or past their expiry, so a stale index can never
   * present a dead offer as selectable.
   */
  get_open_offers: ({milestone_id}: {milestone_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Array<FundingOffer>>>

  /**
   * Construct and simulate a is_fully_funded transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Whether the milestone holds its full protected amount.
   *
   * The MVP financeability precondition. PKG-03 adds the remaining
   * conditions before a finance request may be opened.
   */
  is_fully_funded: ({milestone_id}: {milestone_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<boolean>>>

  /**
   * Construct and simulate a milestone_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Number of milestones created so far, across all orders.
   */
  milestone_count: (options?: MethodOptions) => Promise<AssembledTransaction<u64>>

  /**
   * Construct and simulate a request_finance transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Supplier requests working capital against a fully protected milestone.
   *
   * Authorized by the **supplier** of the milestone's order.
   *
   * Financeability (invariant 23): the milestone must hold its **full**
   * protected amount. A partially funded milestone is not financeable,
   * because the funder's underwriting input would be ambiguous.
   *
   * Requesting finance does not move any money and does not give the
   * supplier access to buyer escrow. It opens the milestone to competing
   * funder offers.
   *
   * A milestone whose previous request expired without being accepted may be
   * re-requested, so an unanswered request cannot strand the milestone.
   */
  request_finance: ({milestone_id, requested_principal, expires_at}: {milestone_id: u64, requested_principal: i128, expires_at: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a resolve_dispute transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The assigned resolver decides a disputed milestone.
   *
   * Authorized by the **order's resolver** (invariant 15).
   *
   * - `Settle` returns the milestone to `Verified`, from where
   * [`Self::settle_milestone`] pays the normal funder-first waterfall.
   * - `Refund` returns the milestone's remaining escrow to the buyer and
   * ends the milestone as `Refunded`.
   *
   * A refund returns **only the escrow this milestone still holds**. It does
   * not reverse an advance a funder already paid the supplier: that money
   * left the funder's wallet for the supplier's and this contract cannot
   * claw it back. The position is marked `Closed` rather than `Repaid` to
   * record exactly that.
   */
  resolve_dispute: ({milestone_id, resolution}: {milestone_id: u64, resolution: DisputeResolution}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a submit_evidence transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Supplier commits a SHA-256 digest of the off-chain evidence.
   *
   * Authorized by the **supplier**. Only the digest is stored: raw documents
   * live in off-chain storage, and this contract attaches no meaning to what
   * the digest covers. A production photo set, a bill of lading and a
   * delivery confirmation are all just 32 bytes here, which is what keeps
   * the same state machine usable for raw materials, production, QC,
   * shipment and delivery without the contract knowing what a ship is.
   *
   * Accepted from `Funded` (unfinanced) or `Financed`, and again from
   * `Submitted` so a supplier can correct a bad upload before anyone
   * verifies it. Once the milestone is verified, disputed or terminal, the
   * evidence is frozen (invariant 18).
   *
   * Submitting evidence moves no money.
   */
  submit_evidence: ({milestone_id, evidence_hash}: {milestone_id: u64, evidence_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a attest_milestone transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The assigned attestor verifies the milestone.
   *
   * Authorized by the **order's attestor** (invariant 14), read from stored
   * state so no other account can verify in their place.
   *
   * The attestor names the digest they reviewed, and it must match what is
   * on record. Without that, a supplier could swap the evidence between the
   * attestor reading it off-chain and their transaction landing, and the
   * attestation would silently cover a document nobody checked.
   *
   * This is the contract's trust boundary and it is a human one: Soroban
   * cannot know that goods were manufactured, loaded, shipped or delivered.
   * It knows only that the assigned attestor signed for this digest.
   */
  attest_milestone: ({milestone_id, evidence_hash}: {milestone_id: u64, evidence_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a create_milestone transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Adds a milestone to an order and returns its id.
   *
   * Authorized by the **buyer**, and only while the order is still `Created`.
   * Once the supplier accepts, the milestone set is frozen: the supplier
   * commits to a known scope, and no party can enlarge the order afterwards.
   *
   * `amount` is the protected milestone payment the buyer will later escrow.
   * Recording it does not move any value; escrow arrives in PKG-02.
   *
   * `deadline` is informational. Its expiry can never settle, refund, repay
   * or penalize by itself (invariant 25) — it only lets the read model derive
   * a `DELAYED` / `NEEDS_REVIEW` display status off-chain.
   */
  create_milestone: ({order_id, amount, deadline}: {order_id: u64, amount: i128, deadline: Option<u64>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a protocol_version transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Protocol version of this contract build. Read-only, unauthenticated.
   */
  protocol_version: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a settle_milestone transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Pays out a verified milestone: **funder first, supplier second**.
   *
   * Authorized by either beneficiary — the supplier, or the funder of an
   * active position. Both have money in the outcome, and settlement carries
   * no discretion: the amounts follow from contract state and cannot be
   * redirected. Letting either side trigger it means neither can withhold
   * the other's money by refusing to act.
   *
   * Requires `Verified` (invariant 8), which is also what makes a disputed
   * milestone unsettleable (invariant 9) and a second settlement impossible
   * (invariant 10): neither status is `Verified`.
   *
   * Both transfers and every state change happen in one invocation, so the
   * funder can never be repaid without the supplier's remainder following.
   */
  settle_milestone: ({milestone_id, caller}: {milestone_id: u64, caller: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_evidence_hash transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Committed evidence digest for a milestone.
   */
  get_evidence_hash: ({milestone_id}: {milestone_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Buffer>>>

  /**
   * Construct and simulate a get_accepted_offer transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The offer the supplier selected, held in persistent storage.
   */
  get_accepted_offer: ({milestone_id}: {milestone_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<FundingOffer>>>

  /**
   * Construct and simulate a get_finance_request transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_finance_request: ({milestone_id}: {milestone_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<FinanceRequest>>>

  /**
   * Construct and simulate a get_finance_position transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_finance_position: ({milestone_id}: {milestone_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<FinancePosition>>>

  /**
   * Construct and simulate a get_order_milestones transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Milestone ids of an existing order, in creation order.
   */
  get_order_milestones: ({order_id}: {order_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Array<u64>>>>

  /**
   * Construct and simulate a get_milestone_dispute transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The dispute attached to a milestone, if one was ever opened.
   */
  get_milestone_dispute: ({milestone_id}: {milestone_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Dispute>>>

  /**
   * Construct and simulate a cancel_finance_request transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Supplier closes a finance request that never produced a funded advance.
   *
   * Authorized by the **supplier**. Covers both a voluntary withdrawal and a
   * request that simply lapsed without an acceptable offer: either way the
   * request is `Open`, and either way the supplier should be able to get on
   * with the work.
   *
   * Refused once an offer has been accepted or a position funded — those are
   * [`Self::release_expired_acceptance`]'s territory, and real financing is
   * never unwound here.
   *
   * The milestone returns to `Funded`: still fully protected, simply no
   * longer seeking financing. From there the supplier can submit evidence
   * and finish unfinanced, or open a fresh request later. Adds no new
   * milestone state and moves no value — buyer escrow is untouched.
   *
   * Returns `true` if the request had already expired.
   */
  cancel_finance_request: ({milestone_id}: {milestone_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<boolean>>>

  /**
   * Construct and simulate a cancel_partial_funding transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Buyer unwinds an incomplete funding attempt.
   *
   * Authorized by the **buyer**. Narrow by construction, and deliberately
   * **not** a general withdrawal: it applies only while the milestone is
   * still `Unfunded`, which is to say still short of its protected amount.
   * Once escrow reaches the full amount the milestone becomes `Funded` and
   * this path is closed forever — buyer protection is not revocable.
   *
   * Without it, a buyer who funded 50% and then stopped would have no exit:
   * the milestone cannot be evidenced, financed or disputed from `Unfunded`,
   * so the partial deposit would sit in escrow with nothing able to move it.
   *
   * Returns the milestone to zero funded, still `Unfunded`, so the buyer may
   * fund it again later. Adds no new milestone state.
   */
  cancel_partial_funding: ({milestone_id}: {milestone_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a get_milestone_offer_ids transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Raw offer-id index for a milestone.
   *
   * The index is temporary and may name offers whose entry has already
   * expired. Prefer [`Self::get_open_offers`], which resolves the ids and
   * drops anything stale.
   */
  get_milestone_offer_ids: ({milestone_id}: {milestone_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Array<u64>>>

  /**
   * Construct and simulate a release_expired_acceptance transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Supplier releases an accepted offer that expired without being funded.
   *
   * Authorized by the **supplier** of the milestone's order.
   *
   * A selected funder is not obliged to advance. Without this, a funder that
   * simply walked away would strand the supplier behind a spent request
   * until the request itself expired — a liveness gap, not a safety one.
   *
   * Allowed only when all of the following hold, so it can never be used to
   * unwind real financing:
   * - an accepted offer exists,
   * - it has passed its expiry,
   * - it was never funded,
   * - no `FinancePosition` exists for the milestone.
   *
   * Recovery takes one of two shapes, and adds **no new milestone state**:
   *
   * - the finance request is still live → it reopens to `Open`, the
   * milestone stays `FinanceRequested`, and the supplier may select
   * another offer or receive new ones;
   * - the finance request has also expired → it closes, and the milestone
   * returns to `Funded` so the supplier can call `request_finance` again.
   *
   * **Moves no value.** Buyer escrow is untouched and no funder capital was
   * ever
   */
  release_expired_acceptance: ({milestone_id}: {milestone_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<boolean>>>

  /**
   * Construct and simulate a has_active_finance_position transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Whether this milestone already carries an ACTIVE finance position.
   */
  has_active_finance_position: ({milestone_id}: {milestone_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {admin, usdc}: {admin: string, usdc: string},
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy({admin, usdc}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAAAAAAADxBIHNpbmdsZSBvZmZlciBieSBpZC4gRXJyb3JzIGlmIGl0cyB0ZW1wb3JhcnkgZW50cnkgaXMgZ29uZS4AAAAJZ2V0X29mZmVyAAAAAAAAAQAAAAAAAAAIb2ZmZXJfaWQAAAAGAAAAAQAAA+kAAAfQAAAADEZ1bmRpbmdPZmZlcgAAAAM=",
        "AAAAAAAAAAAAAAAJZ2V0X29yZGVyAAAAAAAAAQAAAAAAAAAIb3JkZXJfaWQAAAAGAAAAAQAAA+kAAAfQAAAABU9yZGVyAAAAAAAAAw==",
        "AAAAAAAAAAAAAAAKZ2V0X2NvbmZpZwAAAAAAAAAAAAEAAAPpAAAH0AAAAAZDb25maWcAAAAAAAM=",
        "AAAAAAAAAmFBIGZ1bmRlciBwcmljZXMgYW4gb3BlbiBmaW5hbmNlIHJlcXVlc3QuCgpBdXRob3JpemVkIGJ5IHRoZSAqKmZ1bmRlcioqLCB3aG8gbXVzdCBiZSBpbmRlcGVuZGVudCBvZiBidXllciwKc3VwcGxpZXIsIGF0dGVzdG9yIGFuZCByZXNvbHZlci4KCmBwcmluY2lwYWxgIG11c3QgZXF1YWwgdGhlIHJlcXVlc3RlZCBwcmluY2lwYWwgZXhhY3RseSwgc28gY29tcGV0aW5nCm9mZmVycyBkaWZmZXIgb25seSBpbiBgcmVwYXltZW50YCBhbmQgdGhlIHN1cHBsaWVyJ3MgY29tcGFyaXNvbiBpcwp1bmFtYmlndW91cy4gYHJlcGF5bWVudGAgbXVzdCBiZSBhdCBsZWFzdCBgcHJpbmNpcGFsYCBhbmQgYXQgbW9zdCB0aGUKcHJvdGVjdGVkIG1pbGVzdG9uZSBlc2Nyb3cgKGludmFyaWFudHMgMywgNCwgMikuCgpNYWtpbmcgYW4gb2ZmZXIgY29tbWl0cyBubyBjYXBpdGFsLiBUaGUgdHJhbnNmZXIgaGFwcGVucyBpbgpbYFNlbGY6OmZ1bmRfYWR2YW5jZWBdLCBmcm9tIHRoZSBmdW5kZXIncyBvd24gd2FsbGV0LgoKT2ZmZXJzIGxpdmUgaW4gdGVtcG9yYXJ5IHN0b3JhZ2U7IHRoZWlyIGVjb25vbWljcyBiZWNvbWUgcGVybWFuZW50IG9ubHkKd2hlbiB0aGUgc3VwcGxpZXIgYWNjZXB0cy4AAAAAAAAKbWFrZV9vZmZlcgAAAAAABQAAAAAAAAAMbWlsZXN0b25lX2lkAAAABgAAAAAAAAAGZnVuZGVyAAAAAAATAAAAAAAAAAlwcmluY2lwYWwAAAAAAAALAAAAAAAAAAlyZXBheW1lbnQAAAAAAAALAAAAAAAAAApleHBpcmVzX2F0AAAAAAAGAAAAAQAAA+kAAAAGAAAAAw==",
        "AAAAAAAAAD9OdW1iZXIgb2YgZnVuZGluZyBvZmZlcnMgY3JlYXRlZCBzbyBmYXIsIGFjcm9zcyBhbGwgbWlsZXN0b25lcy4AAAAAC29mZmVyX2NvdW50AAAAAAAAAAABAAAABg==",
        "AAAAAAAAAEZOdW1iZXIgb2Ygb3JkZXJzIGNyZWF0ZWQgc28gZmFyOyBhbHNvIHRoZSBpZCBvZiB0aGUgbW9zdCByZWNlbnQgb3JkZXIuAAAAAAALb3JkZXJfY291bnQAAAAAAAAAAAEAAAAG",
        "AAAAAAAAAdRTdXBwbGllciBzZWxlY3RzIGV4YWN0bHkgb25lIG9mZmVyLgoKQXV0aG9yaXplZCBieSB0aGUgKipzdXBwbGllcioqIG9mIHRoZSBtaWxlc3RvbmUncyBvcmRlci4KClRoZSBzZWxlY3RlZCBvZmZlciBpcyBjb3BpZWQgaW50byBwZXJzaXN0ZW50IHN0b3JhZ2UgaGVyZS4gVGhhdCBjb3B5IOKAlApub3QgdGhlIHRlbXBvcmFyeSBvZmZlciBlbnRyeSDigJQgaXMgd2hhdCBbYFNlbGY6OmZ1bmRfYWR2YW5jZWBdIHJlYWRzLCBzbwp0aGUgYWNjZXB0ZWQgZWNvbm9taWNzIHN1cnZpdmUgdGhlIHRlbXBvcmFyeSBlbnRyeSdzIGV4cGlyeSBhbmQgY2Fubm90CmJlIGFsdGVyZWQgYWZ0ZXJ3YXJkcyAoaW52YXJpYW50IDcpLgoKT25seSBvbmUgb2ZmZXIgbWF5IGJlIGFjY2VwdGVkIHBlciBtaWxlc3RvbmU6IHRoZSByZXF1ZXN0IG1vdmVzIHRvCmBBY2NlcHRlZGAsIHdoaWNoIHJlamVjdHMgYW55IGZ1cnRoZXIgYWNjZXB0YW5jZS4AAAAMYWNjZXB0X29mZmVyAAAAAQAAAAAAAAAIb2ZmZXJfaWQAAAAGAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAATxTdXBwbGllciBhY2NlcHRzIHRoZSBvcmRlciwgbW92aW5nIGl0IGBDcmVhdGVkIOKGkiBBY3RpdmVgLgoKQXV0aG9yaXplZCBieSB0aGUgKiphc3NpZ25lZCBzdXBwbGllcioqIG9ubHk7IHRoZSBhZGRyZXNzIGlzIHJlYWQgZnJvbQp0aGUgc3RvcmVkIG9yZGVyIHJhdGhlciB0aGFuIHRha2VuIGFzIGEgcGFyYW1ldGVyLCBzbyBubyBvdGhlciBhY2NvdW50CmNhbiBhY2NlcHQgb24gdGhlaXIgYmVoYWxmLgoKQW4gb3JkZXIgd2l0aCBubyBtaWxlc3RvbmVzIGNhbm5vdCBiZSBhY2NlcHRlZDogdGhlcmUgd291bGQgYmUgbm90aGluZyB0bwpjb21taXQgdG8uAAAADGFjY2VwdF9vcmRlcgAAAAEAAAAAAAAACG9yZGVyX2lkAAAABgAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAALVBIGZ1bmRlciB3aXRoZHJhd3MgYW4gb2ZmZXIgdGhhdCBoYXMgbm90IGJlZW4gYWNjZXB0ZWQuCgpBdXRob3JpemVkIGJ5IHRoZSAqKm9mZmVyJ3Mgb3duIGZ1bmRlcioqLiBBbiBhY2NlcHRlZCBvciBmdW5kZWQgb2ZmZXIKY2Fubm90IGJlIGNhbmNlbGxlZDogaXRzIGVjb25vbWljcyBhcmUgYWxyZWFkeSBsb2NrZWQuAAAAAAAADGNhbmNlbF9vZmZlcgAAAAEAAAAAAAAACG9mZmVyX2lkAAAABgAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAUFCdXllciBjYW5jZWxzIGFuIG9yZGVyIHRoYXQgdGhlIHN1cHBsaWVyIGhhcyBub3QgeWV0IGFjY2VwdGVkLgoKUmVzdHJpY3RlZCB0byBgQ3JlYXRlZGAsIHdoaWNoIGlzIHRoZSBvbmx5IHN0YXR1cyBpbiB3aGljaCBubyBtaWxlc3RvbmUKY2FuIGhvbGQgZXNjcm93LiBDYW5jZWxsaW5nIGFuIGBBY3RpdmVgIG9yZGVyIHdvdWxkIHJlcXVpcmUgdW53aW5kaW5nCmVzY3JvdyBhbmQgYW55IGZpbmFuY2UgcG9zaXRpb24sIHdoaWNoIGlzIGRpc3B1dGUvcmVmdW5kIHRlcnJpdG9yeQooUEtHLTA0KSBhbmQgaXMgZGVsaWJlcmF0ZWx5IG5vdCBhdmFpbGFibGUgaGVyZS4AAAAAAAAMY2FuY2VsX29yZGVyAAAAAQAAAAAAAAAIb3JkZXJfaWQAAAAGAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAk1DcmVhdGVzIGFuIG9yZGVyIGluIGBDcmVhdGVkYCBhbmQgcmV0dXJucyBpdHMgaWQuCgpBdXRob3JpemVkIGJ5IHRoZSAqKmJ1eWVyKiouIFRoZSBzZXR0bGVtZW50IGFzc2V0IGlzIHNuYXBzaG90dGVkIGZyb20KcHJvdG9jb2wgY29uZmlnIHJhdGhlciB0aGFuIGFjY2VwdGVkIGFzIGEgcGFyYW1ldGVyLCBzbyBhbiBvcmRlciBjYW4KbmV2ZXIgYmUgY3JlYXRlZCBhZ2FpbnN0IGEgbm9uLVVTREMgYXNzZXQgKGludmFyaWFudCAyMCkgYW5kIGNhbiBuZXZlcgpoYXZlIGl0cyBhc3NldCBjaGFuZ2VkIGFmdGVyd2FyZHMgKGludmFyaWFudCAxOSkuCgpBdHRlc3RvciBhbmQgcmVzb2x2ZXIgbXVzdCBiZSB0aGlyZCBwYXJ0aWVzOiBhbGxvd2luZyB0aGUgYnV5ZXIgb3IKc3VwcGxpZXIgdG8gYXR0ZXN0IHRoZWlyIG93biBtaWxlc3RvbmUgd291bGQgZGVmZWF0IHRoZSB2ZXJpZmljYXRpb24KbW9kZWwgdGhhdCBzZXR0bGVtZW50IGRlcGVuZHMgb24uIFRoZXkgbXVzdCBhbHNvIGRpZmZlciBmcm9tIGVhY2ggb3RoZXIsCnNvIHRoYXQgYSBkaXNwdXRlZCB2ZXJpZmljYXRpb24gaXMgbmV2ZXIgcmV2aWV3ZWQgYnkgaXRzIG93biBhdXRob3IuAAAAAAAADGNyZWF0ZV9vcmRlcgAAAAQAAAAAAAAABWJ1eWVyAAAAAAAAEwAAAAAAAAAIc3VwcGxpZXIAAAATAAAAAAAAAAhhdHRlc3RvcgAAABMAAAAAAAAACHJlc29sdmVyAAAAEwAAAAEAAAPpAAAABgAAAAM=",
        "AAAAAAAAAzJUaGUgc2VsZWN0ZWQgZnVuZGVyIGFkdmFuY2VzIHdvcmtpbmcgY2FwaXRhbCB0byB0aGUgc3VwcGxpZXIuCgoqKlRoaXMgbW92ZXMgdGhlIGZ1bmRlcidzIG93biBjYXBpdGFsLCBmdW5kZXIgd2FsbGV0IOKGkiBzdXBwbGllciB3YWxsZXQuKioKQnV5ZXIgbWlsZXN0b25lIGVzY3JvdyBpcyBub3QgdGhlIHNvdXJjZSwgaXMgbm90IGRlYml0ZWQsIGFuZApgZnVuZGVkX2Ftb3VudGAgaXMgbm90IHdyaXR0ZW4gYnkgdGhpcyBjYWxsLiBUaGUgYnV5ZXIncyBwcm90ZWN0ZWQKYW1vdW50IGlzIHJlYWQgb25seSBhcyB0aGUgY2VpbGluZyB0aGF0IHJlcGF5bWVudCB3YXMgdmFsaWRhdGVkIGFnYWluc3QuCgpBdXRob3JpemVkIGJ5IHRoZSAqKmFjY2VwdGVkIG9mZmVyJ3MgZnVuZGVyKiosIHJlYWQgZnJvbSBwZXJzaXN0ZW50CnN0YXRlLCBzbyBubyBvdGhlciBhY2NvdW50IGNhbiBmdW5kIGluIHRoZWlyIHBsYWNlLgoKQXRvbWljIHdpdGhpbiBvbmUgaW52b2NhdGlvbjogdmFsaWRhdGUgYWNjZXB0ZWQgb2ZmZXIg4oaSIHZhbGlkYXRlIGV4cGlyeQrihpIgdmFsaWRhdGUgbWlsZXN0b25lIHN0YXRlIOKGkiB2YWxpZGF0ZSBubyBhY3RpdmUgcG9zaXRpb24g4oaSIHJlcXVpcmUKZnVuZGVyIGF1dGgg4oaSIHRyYW5zZmVyIHByaW5jaXBhbCDihpIgcGVyc2lzdCBgRmluYW5jZVBvc2l0aW9uYCDihpIKdHJhbnNpdGlvbiBtaWxlc3RvbmUg4oaSIGVtaXQuIEFueSBmYWlsdXJlIHJldmVydHMgYWxsIG9mIGl0LCBzbyBhbgpgQWN0aXZlYCBwb3NpdGlvbiBjYW4gbmV2ZXIgZXhpc3Qgd2l0aG91dCBpdHMgdHJhbnNmZXIgaGF2aW5nIGhhcHBlbmVkLgAAAAAADGZ1bmRfYWR2YW5jZQAAAAEAAAAAAAAADG1pbGVzdG9uZV9pZAAAAAYAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAbxCdXllciBvciBzdXBwbGllciBmcmVlemVzIGEgc2luZ2xlIG1pbGVzdG9uZSBmb3IgcmV2aWV3LgoKT25seSB0aGlzIG1pbGVzdG9uZSBpcyBhZmZlY3RlZC4gU2libGluZyBtaWxlc3RvbmVzIGtlZXAgdGhlaXIgb3duCmVzY3JvdywgZmluYW5jaW5nIGFuZCB0ZXJtaW5hbCBzdGF0ZXMgdW50b3VjaGVkIChBR0VOVC5tZCDCpzlBLjUpLCB3aGljaAppcyB3aGF0IGxldHMgYSBkZWxpdmVyeSBkaXNwdXRlIG9uIE00IGxlYXZlIHNldHRsZWQgTTEtTTMgYWxvbmUuCgpBIHBhc3NlZCBkZWFkbGluZSBpcyAqKm5vdCoqIGEgcmVhc29uIHRoaXMgZnVuY3Rpb24gZmlyZXMgb24gaXRzIG93bi4KTm90aGluZyBpbiB0aGlzIGNvbnRyYWN0IHJlYWN0cyB0byBhIGRlYWRsaW5lOyBhIHBhcnR5IGhhcyB0byBvcGVuIGEKZGlzcHV0ZSBkZWxpYmVyYXRlbHkgKGludmFyaWFudHMgMjUsIDI2KS4AAAAMb3Blbl9kaXNwdXRlAAAAAgAAAAAAAAAMbWlsZXN0b25lX2lkAAAABgAAAAAAAAAGY2FsbGVyAAAAAAATAAAAAQAAA+kAAAAGAAAAAw==",
        "AAAAAAAAAWJJbml0aWFsaXplcyBwcm90b2NvbCBjb25maWd1cmF0aW9uIGF0IGRlcGxveSB0aW1lLgoKVXNpbmcgYSBjb25zdHJ1Y3RvciByYXRoZXIgdGhhbiBhIGNhbGxhYmxlIGBpbml0aWFsaXplYCByZW1vdmVzIHRoZQpwb3NzaWJpbGl0eSBvZiBhbiB1bmluaXRpYWxpemVkIHdpbmRvdyBvciBhIHNlY29uZCBpbml0aWFsaXphdGlvbjogdGhlCmhvc3QgcnVucyB0aGlzIGV4YWN0bHkgb25jZSwgYXRvbWljYWxseSB3aXRoIGRlcGxveW1lbnQuCgpgYWRtaW5gIGlzIG9wZXJhdGlvbmFsIG9ubHkgYW5kIHJlY2VpdmVzIG5vIGZpbmFuY2lhbCBhdXRob3JpdHkgYW55d2hlcmUKaW4gdGhpcyBjb250cmFjdCAoaW52YXJpYW50IDE3KS4AAAAAAA1fX2NvbnN0cnVjdG9yAAAAAAAAAgAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAAAAAAR1c2RjAAAAEwAAAAA=",
        "AAAAAAAAAAAAAAANZGlzcHV0ZV9jb3VudAAAAAAAAAAAAAABAAAABg==",
        "AAAAAAAAAAAAAAANZ2V0X21pbGVzdG9uZQAAAAAAAAEAAAAAAAAADG1pbGVzdG9uZV9pZAAAAAYAAAABAAAD6QAAB9AAAAAJTWlsZXN0b25lAAAAAAAAAw==",
        "AAAAAAAABABCdXllciBkZXBvc2l0cyBwcm90ZWN0ZWQgbWlsZXN0b25lIHBheW1lbnQgaW50byBjb250cmFjdCBlc2Nyb3cuCgpSZXR1cm5zIHRoZSBtaWxlc3RvbmUncyBjdW11bGF0aXZlIGBmdW5kZWRfYW1vdW50YCBhZnRlciB0aGlzIGRlcG9zaXQuCgoqKlRoaXMgaXMgYnV5ZXIgcHJvdGVjdGlvbiwgbm90IHN1cHBsaWVyIHdvcmtpbmcgY2FwaXRhbC4qKiBUaGUgbW9uZXkKbW92ZXMgYnV5ZXIg4oaSIGNvbnRyYWN0IGFuZCBzdGF5cyB1bmRlciBjb250cmFjdCBjb250cm9sLiBOb3RoaW5nIGluIHRoaXMKcGFja2FnZSBjYW4gcGF5IGl0IHRvIHRoZSBzdXBwbGllciwgYW5kIHRoZSBzdXBwbGllcidzIGVhcmx5IGxpcXVpZGl0eQpjb21lcyBmcm9tIGEgZnVuZGVyJ3Mgb3duIGNhcGl0YWwgaW4gUEtHLTAzLCBuZXZlciBmcm9tIGhlcmUuCgpBdXRob3JpemVkIGJ5IHRoZSAqKmJ1eWVyKiogb2YgdGhlIG1pbGVzdG9uZSdzIG9yZGVyLCByZWFkIGZyb20gc3RvcmVkCnN0YXRlIHJhdGhlciB0aGFuIGEgcGFyYW1ldGVyLgoKVGhlIG9yZGVyIG11c3QgYmUgYEFjdGl2ZWA6IG1vbmV5IGlzIG9ubHkgY29tbWl0dGVkIHRvIGEgc2NvcGUgdGhlCnN1cHBsaWVyIGhhcyBhY2NlcHRlZC4gVGhpcyBhbHNvIGtlZXBzIGBjYW5jZWxfb3JkZXJgICh3aGljaCBpcwpgQ3JlYXRlZGAtb25seSkgcGVybWFuZW50bHkgZGlzam9pbnQgZnJvbSBhbnkgZnVuZGVkIG1pbGVzdG9uZS4KCmBhc3NldGAgbXVzdCBlcXVhbCB0aGUgb3JkZXIncyBzZXR0bGVtZW50IGFzc2V0LiBJdCBpcyBhIHJlcXVpcmVkCnBhcmFtZXRlciBzbyBhIGNsaWVudCBob2xkaW5nIGEgc3RhbGUgb3Igd3JvbmcgYXNzZXQgaWQgZmFpbHMgbG91ZGx5Cmluc3RlYWQgb2Ygc2lsZW50bHkgdHJhbnNmZXJyaW5nIHRoZSByaWdodCBvbmUuCgpQYXJ0aWFsIGRlcG9zaXRzIGFyZSBhbGxvd2VkIGFuZCBhY2N1bXVsYXRlLiBUaGUgbWlsZXN0b25lIG9ubHkgcmVhY2hlcwpgRnVuZGVkYCDigJQgYW5kIHRoZXJlZm9yZSBvbmx5IGJlY29tZXMgZmluYW5jZWFibGUgAAAADmZ1bmRfbWlsZXN0b25lAAAAAAADAAAAAAAAAAxtaWxlc3RvbmVfaWQAAAAGAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAOhPZmZlcnMgb24gYSBtaWxlc3RvbmUgdGhhdCBhcmUgc3RpbGwgb3BlbiBhbmQgc3RpbGwgbGl2ZS4KClJlc29sdmVzIGVhY2ggaW5kZXhlZCBpZCBhbmQgc2tpcHMgZW50cmllcyB0aGF0IGFyZSBtaXNzaW5nLCBjYW5jZWxsZWQsCmFjY2VwdGVkLCBmdW5kZWQgb3IgcGFzdCB0aGVpciBleHBpcnksIHNvIGEgc3RhbGUgaW5kZXggY2FuIG5ldmVyCnByZXNlbnQgYSBkZWFkIG9mZmVyIGFzIHNlbGVjdGFibGUuAAAAD2dldF9vcGVuX29mZmVycwAAAAABAAAAAAAAAAxtaWxlc3RvbmVfaWQAAAAGAAAAAQAAA+oAAAfQAAAADEZ1bmRpbmdPZmZlcg==",
        "AAAAAAAAAKlXaGV0aGVyIHRoZSBtaWxlc3RvbmUgaG9sZHMgaXRzIGZ1bGwgcHJvdGVjdGVkIGFtb3VudC4KClRoZSBNVlAgZmluYW5jZWFiaWxpdHkgcHJlY29uZGl0aW9uLiBQS0ctMDMgYWRkcyB0aGUgcmVtYWluaW5nCmNvbmRpdGlvbnMgYmVmb3JlIGEgZmluYW5jZSByZXF1ZXN0IG1heSBiZSBvcGVuZWQuAAAAAAAAD2lzX2Z1bGx5X2Z1bmRlZAAAAAABAAAAAAAAAAxtaWxlc3RvbmVfaWQAAAAGAAAAAQAAA+kAAAABAAAAAw==",
        "AAAAAAAAADdOdW1iZXIgb2YgbWlsZXN0b25lcyBjcmVhdGVkIHNvIGZhciwgYWNyb3NzIGFsbCBvcmRlcnMuAAAAAA9taWxlc3RvbmVfY291bnQAAAAAAAAAAAEAAAAG",
        "AAAAAAAAAmhTdXBwbGllciByZXF1ZXN0cyB3b3JraW5nIGNhcGl0YWwgYWdhaW5zdCBhIGZ1bGx5IHByb3RlY3RlZCBtaWxlc3RvbmUuCgpBdXRob3JpemVkIGJ5IHRoZSAqKnN1cHBsaWVyKiogb2YgdGhlIG1pbGVzdG9uZSdzIG9yZGVyLgoKRmluYW5jZWFiaWxpdHkgKGludmFyaWFudCAyMyk6IHRoZSBtaWxlc3RvbmUgbXVzdCBob2xkIGl0cyAqKmZ1bGwqKgpwcm90ZWN0ZWQgYW1vdW50LiBBIHBhcnRpYWxseSBmdW5kZWQgbWlsZXN0b25lIGlzIG5vdCBmaW5hbmNlYWJsZSwKYmVjYXVzZSB0aGUgZnVuZGVyJ3MgdW5kZXJ3cml0aW5nIGlucHV0IHdvdWxkIGJlIGFtYmlndW91cy4KClJlcXVlc3RpbmcgZmluYW5jZSBkb2VzIG5vdCBtb3ZlIGFueSBtb25leSBhbmQgZG9lcyBub3QgZ2l2ZSB0aGUKc3VwcGxpZXIgYWNjZXNzIHRvIGJ1eWVyIGVzY3Jvdy4gSXQgb3BlbnMgdGhlIG1pbGVzdG9uZSB0byBjb21wZXRpbmcKZnVuZGVyIG9mZmVycy4KCkEgbWlsZXN0b25lIHdob3NlIHByZXZpb3VzIHJlcXVlc3QgZXhwaXJlZCB3aXRob3V0IGJlaW5nIGFjY2VwdGVkIG1heSBiZQpyZS1yZXF1ZXN0ZWQsIHNvIGFuIHVuYW5zd2VyZWQgcmVxdWVzdCBjYW5ub3Qgc3RyYW5kIHRoZSBtaWxlc3RvbmUuAAAAD3JlcXVlc3RfZmluYW5jZQAAAAADAAAAAAAAAAxtaWxlc3RvbmVfaWQAAAAGAAAAAAAAABNyZXF1ZXN0ZWRfcHJpbmNpcGFsAAAAAAsAAAAAAAAACmV4cGlyZXNfYXQAAAAAAAYAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAoFUaGUgYXNzaWduZWQgcmVzb2x2ZXIgZGVjaWRlcyBhIGRpc3B1dGVkIG1pbGVzdG9uZS4KCkF1dGhvcml6ZWQgYnkgdGhlICoqb3JkZXIncyByZXNvbHZlcioqIChpbnZhcmlhbnQgMTUpLgoKLSBgU2V0dGxlYCByZXR1cm5zIHRoZSBtaWxlc3RvbmUgdG8gYFZlcmlmaWVkYCwgZnJvbSB3aGVyZQpbYFNlbGY6OnNldHRsZV9taWxlc3RvbmVgXSBwYXlzIHRoZSBub3JtYWwgZnVuZGVyLWZpcnN0IHdhdGVyZmFsbC4KLSBgUmVmdW5kYCByZXR1cm5zIHRoZSBtaWxlc3RvbmUncyByZW1haW5pbmcgZXNjcm93IHRvIHRoZSBidXllciBhbmQKZW5kcyB0aGUgbWlsZXN0b25lIGFzIGBSZWZ1bmRlZGAuCgpBIHJlZnVuZCByZXR1cm5zICoqb25seSB0aGUgZXNjcm93IHRoaXMgbWlsZXN0b25lIHN0aWxsIGhvbGRzKiouIEl0IGRvZXMKbm90IHJldmVyc2UgYW4gYWR2YW5jZSBhIGZ1bmRlciBhbHJlYWR5IHBhaWQgdGhlIHN1cHBsaWVyOiB0aGF0IG1vbmV5CmxlZnQgdGhlIGZ1bmRlcidzIHdhbGxldCBmb3IgdGhlIHN1cHBsaWVyJ3MgYW5kIHRoaXMgY29udHJhY3QgY2Fubm90CmNsYXcgaXQgYmFjay4gVGhlIHBvc2l0aW9uIGlzIG1hcmtlZCBgQ2xvc2VkYCByYXRoZXIgdGhhbiBgUmVwYWlkYCB0bwpyZWNvcmQgZXhhY3RseSB0aGF0LgAAAAAAAA9yZXNvbHZlX2Rpc3B1dGUAAAAAAgAAAAAAAAAMbWlsZXN0b25lX2lkAAAABgAAAAAAAAAKcmVzb2x1dGlvbgAAAAAH0AAAABFEaXNwdXRlUmVzb2x1dGlvbgAAAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAu5TdXBwbGllciBjb21taXRzIGEgU0hBLTI1NiBkaWdlc3Qgb2YgdGhlIG9mZi1jaGFpbiBldmlkZW5jZS4KCkF1dGhvcml6ZWQgYnkgdGhlICoqc3VwcGxpZXIqKi4gT25seSB0aGUgZGlnZXN0IGlzIHN0b3JlZDogcmF3IGRvY3VtZW50cwpsaXZlIGluIG9mZi1jaGFpbiBzdG9yYWdlLCBhbmQgdGhpcyBjb250cmFjdCBhdHRhY2hlcyBubyBtZWFuaW5nIHRvIHdoYXQKdGhlIGRpZ2VzdCBjb3ZlcnMuIEEgcHJvZHVjdGlvbiBwaG90byBzZXQsIGEgYmlsbCBvZiBsYWRpbmcgYW5kIGEKZGVsaXZlcnkgY29uZmlybWF0aW9uIGFyZSBhbGwganVzdCAzMiBieXRlcyBoZXJlLCB3aGljaCBpcyB3aGF0IGtlZXBzCnRoZSBzYW1lIHN0YXRlIG1hY2hpbmUgdXNhYmxlIGZvciByYXcgbWF0ZXJpYWxzLCBwcm9kdWN0aW9uLCBRQywKc2hpcG1lbnQgYW5kIGRlbGl2ZXJ5IHdpdGhvdXQgdGhlIGNvbnRyYWN0IGtub3dpbmcgd2hhdCBhIHNoaXAgaXMuCgpBY2NlcHRlZCBmcm9tIGBGdW5kZWRgICh1bmZpbmFuY2VkKSBvciBgRmluYW5jZWRgLCBhbmQgYWdhaW4gZnJvbQpgU3VibWl0dGVkYCBzbyBhIHN1cHBsaWVyIGNhbiBjb3JyZWN0IGEgYmFkIHVwbG9hZCBiZWZvcmUgYW55b25lCnZlcmlmaWVzIGl0LiBPbmNlIHRoZSBtaWxlc3RvbmUgaXMgdmVyaWZpZWQsIGRpc3B1dGVkIG9yIHRlcm1pbmFsLCB0aGUKZXZpZGVuY2UgaXMgZnJvemVuIChpbnZhcmlhbnQgMTgpLgoKU3VibWl0dGluZyBldmlkZW5jZSBtb3ZlcyBubyBtb25leS4AAAAAAA9zdWJtaXRfZXZpZGVuY2UAAAAAAgAAAAAAAAAMbWlsZXN0b25lX2lkAAAABgAAAAAAAAANZXZpZGVuY2VfaGFzaAAAAAAAA+4AAAAgAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAotUaGUgYXNzaWduZWQgYXR0ZXN0b3IgdmVyaWZpZXMgdGhlIG1pbGVzdG9uZS4KCkF1dGhvcml6ZWQgYnkgdGhlICoqb3JkZXIncyBhdHRlc3RvcioqIChpbnZhcmlhbnQgMTQpLCByZWFkIGZyb20gc3RvcmVkCnN0YXRlIHNvIG5vIG90aGVyIGFjY291bnQgY2FuIHZlcmlmeSBpbiB0aGVpciBwbGFjZS4KClRoZSBhdHRlc3RvciBuYW1lcyB0aGUgZGlnZXN0IHRoZXkgcmV2aWV3ZWQsIGFuZCBpdCBtdXN0IG1hdGNoIHdoYXQgaXMKb24gcmVjb3JkLiBXaXRob3V0IHRoYXQsIGEgc3VwcGxpZXIgY291bGQgc3dhcCB0aGUgZXZpZGVuY2UgYmV0d2VlbiB0aGUKYXR0ZXN0b3IgcmVhZGluZyBpdCBvZmYtY2hhaW4gYW5kIHRoZWlyIHRyYW5zYWN0aW9uIGxhbmRpbmcsIGFuZCB0aGUKYXR0ZXN0YXRpb24gd291bGQgc2lsZW50bHkgY292ZXIgYSBkb2N1bWVudCBub2JvZHkgY2hlY2tlZC4KClRoaXMgaXMgdGhlIGNvbnRyYWN0J3MgdHJ1c3QgYm91bmRhcnkgYW5kIGl0IGlzIGEgaHVtYW4gb25lOiBTb3JvYmFuCmNhbm5vdCBrbm93IHRoYXQgZ29vZHMgd2VyZSBtYW51ZmFjdHVyZWQsIGxvYWRlZCwgc2hpcHBlZCBvciBkZWxpdmVyZWQuCkl0IGtub3dzIG9ubHkgdGhhdCB0aGUgYXNzaWduZWQgYXR0ZXN0b3Igc2lnbmVkIGZvciB0aGlzIGRpZ2VzdC4AAAAAEGF0dGVzdF9taWxlc3RvbmUAAAACAAAAAAAAAAxtaWxlc3RvbmVfaWQAAAAGAAAAAAAAAA1ldmlkZW5jZV9oYXNoAAAAAAAD7gAAACAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAl9BZGRzIGEgbWlsZXN0b25lIHRvIGFuIG9yZGVyIGFuZCByZXR1cm5zIGl0cyBpZC4KCkF1dGhvcml6ZWQgYnkgdGhlICoqYnV5ZXIqKiwgYW5kIG9ubHkgd2hpbGUgdGhlIG9yZGVyIGlzIHN0aWxsIGBDcmVhdGVkYC4KT25jZSB0aGUgc3VwcGxpZXIgYWNjZXB0cywgdGhlIG1pbGVzdG9uZSBzZXQgaXMgZnJvemVuOiB0aGUgc3VwcGxpZXIKY29tbWl0cyB0byBhIGtub3duIHNjb3BlLCBhbmQgbm8gcGFydHkgY2FuIGVubGFyZ2UgdGhlIG9yZGVyIGFmdGVyd2FyZHMuCgpgYW1vdW50YCBpcyB0aGUgcHJvdGVjdGVkIG1pbGVzdG9uZSBwYXltZW50IHRoZSBidXllciB3aWxsIGxhdGVyIGVzY3Jvdy4KUmVjb3JkaW5nIGl0IGRvZXMgbm90IG1vdmUgYW55IHZhbHVlOyBlc2Nyb3cgYXJyaXZlcyBpbiBQS0ctMDIuCgpgZGVhZGxpbmVgIGlzIGluZm9ybWF0aW9uYWwuIEl0cyBleHBpcnkgY2FuIG5ldmVyIHNldHRsZSwgcmVmdW5kLCByZXBheQpvciBwZW5hbGl6ZSBieSBpdHNlbGYgKGludmFyaWFudCAyNSkg4oCUIGl0IG9ubHkgbGV0cyB0aGUgcmVhZCBtb2RlbCBkZXJpdmUKYSBgREVMQVlFRGAgLyBgTkVFRFNfUkVWSUVXYCBkaXNwbGF5IHN0YXR1cyBvZmYtY2hhaW4uAAAAABBjcmVhdGVfbWlsZXN0b25lAAAAAwAAAAAAAAAIb3JkZXJfaWQAAAAGAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAACGRlYWRsaW5lAAAD6AAAAAYAAAABAAAD6QAAAAYAAAAD",
        "AAAAAAAAAERQcm90b2NvbCB2ZXJzaW9uIG9mIHRoaXMgY29udHJhY3QgYnVpbGQuIFJlYWQtb25seSwgdW5hdXRoZW50aWNhdGVkLgAAABBwcm90b2NvbF92ZXJzaW9uAAAAAAAAAAEAAAAE",
        "AAAAAAAAAs5QYXlzIG91dCBhIHZlcmlmaWVkIG1pbGVzdG9uZTogKipmdW5kZXIgZmlyc3QsIHN1cHBsaWVyIHNlY29uZCoqLgoKQXV0aG9yaXplZCBieSBlaXRoZXIgYmVuZWZpY2lhcnkg4oCUIHRoZSBzdXBwbGllciwgb3IgdGhlIGZ1bmRlciBvZiBhbgphY3RpdmUgcG9zaXRpb24uIEJvdGggaGF2ZSBtb25leSBpbiB0aGUgb3V0Y29tZSwgYW5kIHNldHRsZW1lbnQgY2FycmllcwpubyBkaXNjcmV0aW9uOiB0aGUgYW1vdW50cyBmb2xsb3cgZnJvbSBjb250cmFjdCBzdGF0ZSBhbmQgY2Fubm90IGJlCnJlZGlyZWN0ZWQuIExldHRpbmcgZWl0aGVyIHNpZGUgdHJpZ2dlciBpdCBtZWFucyBuZWl0aGVyIGNhbiB3aXRoaG9sZAp0aGUgb3RoZXIncyBtb25leSBieSByZWZ1c2luZyB0byBhY3QuCgpSZXF1aXJlcyBgVmVyaWZpZWRgIChpbnZhcmlhbnQgOCksIHdoaWNoIGlzIGFsc28gd2hhdCBtYWtlcyBhIGRpc3B1dGVkCm1pbGVzdG9uZSB1bnNldHRsZWFibGUgKGludmFyaWFudCA5KSBhbmQgYSBzZWNvbmQgc2V0dGxlbWVudCBpbXBvc3NpYmxlCihpbnZhcmlhbnQgMTApOiBuZWl0aGVyIHN0YXR1cyBpcyBgVmVyaWZpZWRgLgoKQm90aCB0cmFuc2ZlcnMgYW5kIGV2ZXJ5IHN0YXRlIGNoYW5nZSBoYXBwZW4gaW4gb25lIGludm9jYXRpb24sIHNvIHRoZQpmdW5kZXIgY2FuIG5ldmVyIGJlIHJlcGFpZCB3aXRob3V0IHRoZSBzdXBwbGllcidzIHJlbWFpbmRlciBmb2xsb3dpbmcuAAAAAAAQc2V0dGxlX21pbGVzdG9uZQAAAAIAAAAAAAAADG1pbGVzdG9uZV9pZAAAAAYAAAAAAAAABmNhbGxlcgAAAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAACpDb21taXR0ZWQgZXZpZGVuY2UgZGlnZXN0IGZvciBhIG1pbGVzdG9uZS4AAAAAABFnZXRfZXZpZGVuY2VfaGFzaAAAAAAAAAEAAAAAAAAADG1pbGVzdG9uZV9pZAAAAAYAAAABAAAD6QAAA+4AAAAgAAAAAw==",
        "AAAAAAAAADxUaGUgb2ZmZXIgdGhlIHN1cHBsaWVyIHNlbGVjdGVkLCBoZWxkIGluIHBlcnNpc3RlbnQgc3RvcmFnZS4AAAASZ2V0X2FjY2VwdGVkX29mZmVyAAAAAAABAAAAAAAAAAxtaWxlc3RvbmVfaWQAAAAGAAAAAQAAA+kAAAfQAAAADEZ1bmRpbmdPZmZlcgAAAAM=",
        "AAAAAAAAAAAAAAATZ2V0X2ZpbmFuY2VfcmVxdWVzdAAAAAABAAAAAAAAAAxtaWxlc3RvbmVfaWQAAAAGAAAAAQAAA+kAAAfQAAAADkZpbmFuY2VSZXF1ZXN0AAAAAAAD",
        "AAAAAAAAAAAAAAAUZ2V0X2ZpbmFuY2VfcG9zaXRpb24AAAABAAAAAAAAAAxtaWxlc3RvbmVfaWQAAAAGAAAAAQAAA+kAAAfQAAAAD0ZpbmFuY2VQb3NpdGlvbgAAAAAD",
        "AAAAAAAAADZNaWxlc3RvbmUgaWRzIG9mIGFuIGV4aXN0aW5nIG9yZGVyLCBpbiBjcmVhdGlvbiBvcmRlci4AAAAAABRnZXRfb3JkZXJfbWlsZXN0b25lcwAAAAEAAAAAAAAACG9yZGVyX2lkAAAABgAAAAEAAAPpAAAD6gAAAAYAAAAD",
        "AAAAAAAAADxUaGUgZGlzcHV0ZSBhdHRhY2hlZCB0byBhIG1pbGVzdG9uZSwgaWYgb25lIHdhcyBldmVyIG9wZW5lZC4AAAAVZ2V0X21pbGVzdG9uZV9kaXNwdXRlAAAAAAAAAQAAAAAAAAAMbWlsZXN0b25lX2lkAAAABgAAAAEAAAPpAAAH0AAAAAdEaXNwdXRlAAAAAAM=",
        "AAAAAAAAAxpTdXBwbGllciBjbG9zZXMgYSBmaW5hbmNlIHJlcXVlc3QgdGhhdCBuZXZlciBwcm9kdWNlZCBhIGZ1bmRlZCBhZHZhbmNlLgoKQXV0aG9yaXplZCBieSB0aGUgKipzdXBwbGllcioqLiBDb3ZlcnMgYm90aCBhIHZvbHVudGFyeSB3aXRoZHJhd2FsIGFuZCBhCnJlcXVlc3QgdGhhdCBzaW1wbHkgbGFwc2VkIHdpdGhvdXQgYW4gYWNjZXB0YWJsZSBvZmZlcjogZWl0aGVyIHdheSB0aGUKcmVxdWVzdCBpcyBgT3BlbmAsIGFuZCBlaXRoZXIgd2F5IHRoZSBzdXBwbGllciBzaG91bGQgYmUgYWJsZSB0byBnZXQgb24Kd2l0aCB0aGUgd29yay4KClJlZnVzZWQgb25jZSBhbiBvZmZlciBoYXMgYmVlbiBhY2NlcHRlZCBvciBhIHBvc2l0aW9uIGZ1bmRlZCDigJQgdGhvc2UgYXJlCltgU2VsZjo6cmVsZWFzZV9leHBpcmVkX2FjY2VwdGFuY2VgXSdzIHRlcnJpdG9yeSwgYW5kIHJlYWwgZmluYW5jaW5nIGlzCm5ldmVyIHVud291bmQgaGVyZS4KClRoZSBtaWxlc3RvbmUgcmV0dXJucyB0byBgRnVuZGVkYDogc3RpbGwgZnVsbHkgcHJvdGVjdGVkLCBzaW1wbHkgbm8KbG9uZ2VyIHNlZWtpbmcgZmluYW5jaW5nLiBGcm9tIHRoZXJlIHRoZSBzdXBwbGllciBjYW4gc3VibWl0IGV2aWRlbmNlCmFuZCBmaW5pc2ggdW5maW5hbmNlZCwgb3Igb3BlbiBhIGZyZXNoIHJlcXVlc3QgbGF0ZXIuIEFkZHMgbm8gbmV3Cm1pbGVzdG9uZSBzdGF0ZSBhbmQgbW92ZXMgbm8gdmFsdWUg4oCUIGJ1eWVyIGVzY3JvdyBpcyB1bnRvdWNoZWQuCgpSZXR1cm5zIGB0cnVlYCBpZiB0aGUgcmVxdWVzdCBoYWQgYWxyZWFkeSBleHBpcmVkLgAAAAAAFmNhbmNlbF9maW5hbmNlX3JlcXVlc3QAAAAAAAEAAAAAAAAADG1pbGVzdG9uZV9pZAAAAAYAAAABAAAD6QAAAAEAAAAD",
        "AAAAAAAAAuBCdXllciB1bndpbmRzIGFuIGluY29tcGxldGUgZnVuZGluZyBhdHRlbXB0LgoKQXV0aG9yaXplZCBieSB0aGUgKipidXllcioqLiBOYXJyb3cgYnkgY29uc3RydWN0aW9uLCBhbmQgZGVsaWJlcmF0ZWx5Cioqbm90KiogYSBnZW5lcmFsIHdpdGhkcmF3YWw6IGl0IGFwcGxpZXMgb25seSB3aGlsZSB0aGUgbWlsZXN0b25lIGlzCnN0aWxsIGBVbmZ1bmRlZGAsIHdoaWNoIGlzIHRvIHNheSBzdGlsbCBzaG9ydCBvZiBpdHMgcHJvdGVjdGVkIGFtb3VudC4KT25jZSBlc2Nyb3cgcmVhY2hlcyB0aGUgZnVsbCBhbW91bnQgdGhlIG1pbGVzdG9uZSBiZWNvbWVzIGBGdW5kZWRgIGFuZAp0aGlzIHBhdGggaXMgY2xvc2VkIGZvcmV2ZXIg4oCUIGJ1eWVyIHByb3RlY3Rpb24gaXMgbm90IHJldm9jYWJsZS4KCldpdGhvdXQgaXQsIGEgYnV5ZXIgd2hvIGZ1bmRlZCA1MCUgYW5kIHRoZW4gc3RvcHBlZCB3b3VsZCBoYXZlIG5vIGV4aXQ6CnRoZSBtaWxlc3RvbmUgY2Fubm90IGJlIGV2aWRlbmNlZCwgZmluYW5jZWQgb3IgZGlzcHV0ZWQgZnJvbSBgVW5mdW5kZWRgLApzbyB0aGUgcGFydGlhbCBkZXBvc2l0IHdvdWxkIHNpdCBpbiBlc2Nyb3cgd2l0aCBub3RoaW5nIGFibGUgdG8gbW92ZSBpdC4KClJldHVybnMgdGhlIG1pbGVzdG9uZSB0byB6ZXJvIGZ1bmRlZCwgc3RpbGwgYFVuZnVuZGVkYCwgc28gdGhlIGJ1eWVyIG1heQpmdW5kIGl0IGFnYWluIGxhdGVyLiBBZGRzIG5vIG5ldyBtaWxlc3RvbmUgc3RhdGUuAAAAFmNhbmNlbF9wYXJ0aWFsX2Z1bmRpbmcAAAAAAAEAAAAAAAAADG1pbGVzdG9uZV9pZAAAAAYAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAMNSYXcgb2ZmZXItaWQgaW5kZXggZm9yIGEgbWlsZXN0b25lLgoKVGhlIGluZGV4IGlzIHRlbXBvcmFyeSBhbmQgbWF5IG5hbWUgb2ZmZXJzIHdob3NlIGVudHJ5IGhhcyBhbHJlYWR5CmV4cGlyZWQuIFByZWZlciBbYFNlbGY6OmdldF9vcGVuX29mZmVyc2BdLCB3aGljaCByZXNvbHZlcyB0aGUgaWRzIGFuZApkcm9wcyBhbnl0aGluZyBzdGFsZS4AAAAAF2dldF9taWxlc3RvbmVfb2ZmZXJfaWRzAAAAAAEAAAAAAAAADG1pbGVzdG9uZV9pZAAAAAYAAAABAAAD6gAAAAY=",
        "AAAAAAAABABTdXBwbGllciByZWxlYXNlcyBhbiBhY2NlcHRlZCBvZmZlciB0aGF0IGV4cGlyZWQgd2l0aG91dCBiZWluZyBmdW5kZWQuCgpBdXRob3JpemVkIGJ5IHRoZSAqKnN1cHBsaWVyKiogb2YgdGhlIG1pbGVzdG9uZSdzIG9yZGVyLgoKQSBzZWxlY3RlZCBmdW5kZXIgaXMgbm90IG9ibGlnZWQgdG8gYWR2YW5jZS4gV2l0aG91dCB0aGlzLCBhIGZ1bmRlciB0aGF0CnNpbXBseSB3YWxrZWQgYXdheSB3b3VsZCBzdHJhbmQgdGhlIHN1cHBsaWVyIGJlaGluZCBhIHNwZW50IHJlcXVlc3QKdW50aWwgdGhlIHJlcXVlc3QgaXRzZWxmIGV4cGlyZWQg4oCUIGEgbGl2ZW5lc3MgZ2FwLCBub3QgYSBzYWZldHkgb25lLgoKQWxsb3dlZCBvbmx5IHdoZW4gYWxsIG9mIHRoZSBmb2xsb3dpbmcgaG9sZCwgc28gaXQgY2FuIG5ldmVyIGJlIHVzZWQgdG8KdW53aW5kIHJlYWwgZmluYW5jaW5nOgotIGFuIGFjY2VwdGVkIG9mZmVyIGV4aXN0cywKLSBpdCBoYXMgcGFzc2VkIGl0cyBleHBpcnksCi0gaXQgd2FzIG5ldmVyIGZ1bmRlZCwKLSBubyBgRmluYW5jZVBvc2l0aW9uYCBleGlzdHMgZm9yIHRoZSBtaWxlc3RvbmUuCgpSZWNvdmVyeSB0YWtlcyBvbmUgb2YgdHdvIHNoYXBlcywgYW5kIGFkZHMgKipubyBuZXcgbWlsZXN0b25lIHN0YXRlKio6CgotIHRoZSBmaW5hbmNlIHJlcXVlc3QgaXMgc3RpbGwgbGl2ZSDihpIgaXQgcmVvcGVucyB0byBgT3BlbmAsIHRoZQptaWxlc3RvbmUgc3RheXMgYEZpbmFuY2VSZXF1ZXN0ZWRgLCBhbmQgdGhlIHN1cHBsaWVyIG1heSBzZWxlY3QKYW5vdGhlciBvZmZlciBvciByZWNlaXZlIG5ldyBvbmVzOwotIHRoZSBmaW5hbmNlIHJlcXVlc3QgaGFzIGFsc28gZXhwaXJlZCDihpIgaXQgY2xvc2VzLCBhbmQgdGhlIG1pbGVzdG9uZQpyZXR1cm5zIHRvIGBGdW5kZWRgIHNvIHRoZSBzdXBwbGllciBjYW4gY2FsbCBgcmVxdWVzdF9maW5hbmNlYCBhZ2Fpbi4KCioqTW92ZXMgbm8gdmFsdWUuKiogQnV5ZXIgZXNjcm93IGlzIHVudG91Y2hlZCBhbmQgbm8gZnVuZGVyIGNhcGl0YWwgd2FzCmV2ZXIgAAAAGnJlbGVhc2VfZXhwaXJlZF9hY2NlcHRhbmNlAAAAAAABAAAAAAAAAAxtaWxlc3RvbmVfaWQAAAAGAAAAAQAAA+kAAAABAAAAAw==",
        "AAAAAAAAAEJXaGV0aGVyIHRoaXMgbWlsZXN0b25lIGFscmVhZHkgY2FycmllcyBhbiBBQ1RJVkUgZmluYW5jZSBwb3NpdGlvbi4AAAAAABtoYXNfYWN0aXZlX2ZpbmFuY2VfcG9zaXRpb24AAAAAAQAAAAAAAAAMbWlsZXN0b25lX2lkAAAABgAAAAEAAAAB",
        "AAAAAQAAAV9BIGNvbW1lcmNpYWwgb3JkZXIgYmV0d2VlbiBvbmUgYnV5ZXIgYW5kIG9uZSBzdXBwbGllci4KCkV2ZXJ5IGFkZHJlc3MgZmllbGQgaXMgYXNzaWduZWQgYXQgY3JlYXRpb24gYW5kIGltbXV0YWJsZSBhZnRlcndhcmRzOiBubwpmdW5jdGlvbiBpbiB0aGlzIGNvbnRyYWN0IG11dGF0ZXMgYGJ1eWVyYCwgYHN1cHBsaWVyYCwgYGF0dGVzdG9yYCwgYHJlc29sdmVyYApvciBgYXNzZXRgLiBUaGlzIGlzIHdoYXQgbWFrZXMgIm9ubHkgdGhlIGFzc2lnbmVkIGF0dGVzdG9yIGNhbiB2ZXJpZnkiCihpbnZhcmlhbnQgMTQpIGFuZCAib3JkZXIgYXNzZXQgaXMgaW1tdXRhYmxlIiAoaW52YXJpYW50IDE5KSBlbmZvcmNlYWJsZS4AAAAAAAAAAAVPcmRlcgAAAAAAAAgAAAA9U2V0dGxlbWVudCBhc3NldCwgc25hcHNob3R0ZWQgZnJvbSBgQ29uZmlnLnVzZGNgIGF0IGNyZWF0aW9uLgAAAAAAAAVhc3NldAAAAAAAABMAAAAxQXV0aG9yaXplZCB0byB2ZXJpZnkgbWlsZXN0b25lIGV2aWRlbmNlIChQS0ctMDQpLgAAAAAAAAhhdHRlc3RvcgAAABMAAABKUHJlZnVuZHMgcHJvdGVjdGVkIG1pbGVzdG9uZSBlc2Nyb3cuIE5ldmVyIHRoZSBzdXBwbGllcidzIHdvcmtpbmcgY2FwaXRhbC4AAAAAAAVidXllcgAAAAAAABMAAAAAAAAACmNyZWF0ZWRfYXQAAAAAAAYAAAAAAAAAAmlkAAAAAAAGAAAANEF1dGhvcml6ZWQgdG8gcmVzb2x2ZSBhIGRpc3B1dGVkIG1pbGVzdG9uZSAoUEtHLTA0KS4AAAAIcmVzb2x2ZXIAAAATAAAAAAAAAAZzdGF0dXMAAAAAB9AAAAALT3JkZXJTdGF0dXMAAAAAAAAAAAhzdXBwbGllcgAAABM=",
        "AAAAAQAAAR1HbG9iYWwgcHJvdG9jb2wgY29uZmlndXJhdGlvbiAoaW5zdGFuY2Ugc3RvcmFnZSkuCgpgYWRtaW5gIGlzIGFuIG9wZXJhdGlvbmFsIHJvbGUgb25seS4gUGVyIEFHRU5ULm1kIMKnMTkgaW52YXJpYW50IDE3IHRoZSBhZG1pbgpoYXMgKipubyoqIGF1dGhvcml0eSB0byBtb3ZlLCB3aXRoZHJhdyBvciByZWRpcmVjdCB1c2VyIGZ1bmRzLCBhbmQgbm8gZnVuY3Rpb24KaW4gdGhpcyBjb250cmFjdCBncmFudHMgaXQgYW55LiBJdCBleGlzdHMgdG8gaWRlbnRpZnkgdGhlIGRlcGxveWluZyBvcGVyYXRvci4AAAAAAAAAAAAABkNvbmZpZwAAAAAAAwAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAAAAABBwcm90b2NvbF92ZXJzaW9uAAAABAAAAEJTZXR0bGVtZW50IGFzc2V0IGNvbnRyYWN0IChVU0RDIFNBQykuIE1WUCByZWplY3RzIGFueSBvdGhlciBhc3NldC4AAAAAAAR1c2RjAAAAEw==",
        "AAAAAQAAAMZBIGRpc3B1dGUgb3ZlciBleGFjdGx5IG9uZSBtaWxlc3RvbmUuCgpEaXNwdXRlcyBhcmUgbWlsZXN0b25lLXNjb3BlZCBzbyB0aGF0IGZyZWV6aW5nIE00IGNhbm5vdCBkaXN0dXJiIGFscmVhZHkKc2V0dGxlZCBNMeKAk00zIChBR0VOVC5tZCDCpzlBLjUpLgoKRGVjbGFyZWQgaW4gUEtHLTAxOyBjcmVhdGVkIGFuZCBtdXRhdGVkIGluIFBLRy0wNC4AAAAAAAAAAAAHRGlzcHV0ZQAAAAAGAAAAAAAAAAJpZAAAAAAABgAAAAAAAAAMbWlsZXN0b25lX2lkAAAABgAAAAAAAAAJb3BlbmVkX2F0AAAAAAAABgAAAAAAAAAJb3BlbmVkX2J5AAAAAAAAEwAAAAAAAAAIcmVzb2x2ZXIAAAATAAAAAAAAAAZzdGF0dXMAAAAAB9AAAAANRGlzcHV0ZVN0YXR1cwAAAA==",
        "AAAAAQAAAZNBIHNpbmdsZSBwcm90ZWN0ZWQgcHJvZHVjdGlvbiBtaWxlc3RvbmUuCgpUaGUgY29udHJhY3QgaXMgaW50ZW50aW9uYWxseSBnZW5lcmljOiB0aGVyZSBpcyBubyBsYWJlbCwgY2FycmllciwgcG9ydCwKdmVzc2VsIG9yIEJpbGwgb2YgTGFkaW5nIGZpZWxkLiBBIG1pbGVzdG9uZSBtZWFuaW5nICJRQyArIEhhbmRlZCB0byBDYXJyaWVyIgpvciAiRGVsaXZlcnkgQ29uZmlybWVkIiBpcyBsYWJlbGxlZCBvZmYtY2hhaW4gKEFHRU5ULm1kIMKnOUEsIMKnMjApLiBUaGF0IGtlZXBzCnRoZSBzYW1lIHN0YXRlIG1hY2hpbmUgdXNhYmxlIGZvciByYXcgbWF0ZXJpYWxzLCBwcm9kdWN0aW9uLCBRQywgc2hpcG1lbnQgYW5kCmRlbGl2ZXJ5IHdpdGhvdXQgdGhlIGNvbnRyYWN0IGtub3dpbmcgd2hhdCBhIHNoaXAgaXMuAAAAAAAAAAAJTWlsZXN0b25lAAAAAAAACQAAAEhQcm90ZWN0ZWQgbWlsZXN0b25lIHBheW1lbnQgdGhlIGJ1eWVyIGNvbW1pdHMgdG8gZXNjcm93LCBpbiBhc3NldCB1bml0cy4AAAAGYW1vdW50AAAAAAALAAAAAAAAAApjcmVhdGVkX2F0AAAAAAAGAAAAfUluZm9ybWF0aW9uYWwgdGFyZ2V0IGRhdGUuIEV4cGlyeSBhbG9uZSBtdXN0IG5ldmVyIG1vdmUgZnVuZHMKKGludmFyaWFudCAyNSk7IGl0IGNhbiBvbmx5IHN1cmZhY2UgYSBkZXJpdmVkIHN0YXR1cyBvZmYtY2hhaW4uAAAAAAAACGRlYWRsaW5lAAAD6AAAAAYAAAEKU0hBLTI1NiBjb21taXRtZW50IHRvIHRoZSBvZmYtY2hhaW4gZXZpZGVuY2UgZm9yIHRoaXMgbWlsZXN0b25lLgoKT25seSB0aGUgZGlnZXN0IGxpdmVzIG9uIGNoYWluLiBSYXcgZG9jdW1lbnRzIOKAlCBiaWxscyBvZiBsYWRpbmcsIFFDCnJlcG9ydHMsIHBhY2tpbmcgbGlzdHMsIGRlbGl2ZXJ5IGNvbmZpcm1hdGlvbnMg4oCUIHN0YXkgb2ZmLWNoYWluLCBhbmQgdGhlCmNvbnRyYWN0IGF0dGFjaGVzIG5vIG1lYW5pbmcgdG8gd2hhdCB0aGUgZGlnZXN0IGNvdmVycy4AAAAAAA1ldmlkZW5jZV9oYXNoAAAAAAAD6AAAA+4AAAAgAAAAh0J1eWVyIGVzY3JvdyBhY3R1YWxseSByZWNlaXZlZCBzbyBmYXIuIE11dGF0ZWQgb25seSBieSBQS0ctMDIuCgpUaGlzIGlzICoqYnV5ZXIgbW9uZXkgaGVsZCBieSB0aGUgY29udHJhY3QqKiwgbmV2ZXIgYSBzdXBwbGllciBiYWxhbmNlLgAAAAANZnVuZGVkX2Ftb3VudAAAAAAAAAsAAAAAAAAAAmlkAAAAAAAGAAAANlBvc2l0aW9uIHdpdGhpbiB0aGUgb3JkZXIsIGFzc2lnbmVkIGluIGNyZWF0aW9uIG9yZGVyLgAAAAAABWluZGV4AAAAAAAABAAAAAAAAAAIb3JkZXJfaWQAAAAGAAAAAAAAAAZzdGF0dXMAAAAAB9AAAAAPTWlsZXN0b25lU3RhdHVzAA==",
        "AAAAAwAAAAAAAAAAAAAAC09mZmVyU3RhdHVzAAAAAAQAAAAAAAAABE9wZW4AAAAAAAAAAAAAAAlDYW5jZWxsZWQAAAAAAAABAAAAAAAAAAhBY2NlcHRlZAAAAAIAAAAAAAAABkZ1bmRlZAAAAAAAAw==",
        "AAAAAwAAAP9PcmRlciBsaWZlY3ljbGUgKEFHRU5ULm1kIMKnMTcpLgoKYGBgdGV4dApDUkVBVEVEIOKGkiBBQ1RJVkUg4oaSIENPTVBMRVRFRArilJTilIDilIDilIDihpIgQ0FOQ0VMTEVECmBgYAoKYENvbXBsZXRlZGAgaXMgcmVhY2hlZCBvbmx5IHdoZW4gZXZlcnkgbWlsZXN0b25lIGlzIHRlcm1pbmFsLiBUaGF0IHRyYW5zaXRpb24KZGVwZW5kcyBvbiBzZXR0bGVtZW50IGFuZCBpcyB0aGVyZWZvcmUgaW1wbGVtZW50ZWQgaW4gUEtHLTA0LCBub3QgaGVyZS4AAAAAAAAAAAtPcmRlclN0YXR1cwAAAAAEAAAAAAAAAAdDcmVhdGVkAAAAAAAAAAAAAAAABkFjdGl2ZQAAAAAAAQAAAAAAAAAJQ29tcGxldGVkAAAAAAAAAgAAAAAAAAAJQ2FuY2VsbGVkAAAAAAAAAw==",
        "AAAAAQAAAQNBIGNvbXBldGluZyBmdW5kZXIncyBwcmljZWQgb2ZmZXIuIEhlbGQgaW4gdGVtcG9yYXJ5IHN0b3JhZ2Ugd2hpbGUgb3BlbgooQUdFTlQubWQgwqcxOCk7IGFjY2VwdGVkIGVjb25vbWljcyBhcmUgY29waWVkIGludG8gYSBwZXJzaXN0ZW50CmBGaW5hbmNlUG9zaXRpb25gIGF0IGZ1bmRpbmcgdGltZSBzbyB0aGV5IGNhbiBuZXZlciBjaGFuZ2UgYWZ0ZXJ3YXJkcy4KCkRlY2xhcmVkIGluIFBLRy0wMTsgY3JlYXRlZCBhbmQgbXV0YXRlZCBpbiBQS0ctMDMuAAAAAAAAAAAMRnVuZGluZ09mZmVyAAAABwAAAAAAAAAKZXhwaXJlc19hdAAAAAAABgAAAAAAAAAGZnVuZGVyAAAAAAATAAAAAAAAAAJpZAAAAAAABgAAAAAAAAAMbWlsZXN0b25lX2lkAAAABgAAADdBZHZhbmNlZCB0byB0aGUgc3VwcGxpZXIgZnJvbSB0aGUgZnVuZGVyJ3Mgb3duIGNhcGl0YWwuAAAAAAlwcmluY2lwYWwAAAAAAAALAAAAPFJlcGFpZCB0byB0aGUgZnVuZGVyIGZpcnN0IG91dCBvZiB2ZXJpZmllZCBtaWxlc3RvbmUgZXNjcm93LgAAAAlyZXBheW1lbnQAAAAAAAALAAAAAAAAAAZzdGF0dXMAAAAAB9AAAAALT2ZmZXJTdGF0dXMA",
        "AAAAAwAAAKxEaXNwdXRlIGxpZmVjeWNsZS4gVGhlIHJlc29sdXRpb24gaXMgZW5jb2RlZCBpbiB0aGUgdGVybWluYWwgc3RhdHVzIHJhdGhlcgp0aGFuIHN0b3JlZCBzZXBhcmF0ZWx5LCBzbyBhIHJlc29sdmVkIGRpc3B1dGUgY2FuIG5ldmVyIGNhcnJ5IGEgbWlzc2luZyBvcgpjb250cmFkaWN0b3J5IG91dGNvbWUuAAAAAAAAAA1EaXNwdXRlU3RhdHVzAAAAAAAAAwAAAAAAAAAET3BlbgAAAAAAAAAAAAAADlJlc29sdmVkU2V0dGxlAAAAAAABAAAAAAAAAA5SZXNvbHZlZFJlZnVuZAAAAAAAAg==",
        "AAAAAQAAAIFBIHN1cHBsaWVyJ3MgcmVxdWVzdCBmb3Igd29ya2luZyBjYXBpdGFsIGFnYWluc3QgYSBmdWxseSBwcm90ZWN0ZWQgbWlsZXN0b25lLgoKRGVjbGFyZWQgaW4gUEtHLTAxOyBjcmVhdGVkIGFuZCBtdXRhdGVkIGluIFBLRy0wMy4AAAAAAAAAAAAADkZpbmFuY2VSZXF1ZXN0AAAAAAAGAAAAAAAAAApjcmVhdGVkX2F0AAAAAAAGAAAAAAAAAApleHBpcmVzX2F0AAAAAAAGAAAAAAAAAAxtaWxlc3RvbmVfaWQAAAAGAAAAAAAAABNyZXF1ZXN0ZWRfcHJpbmNpcGFsAAAAAAsAAAAAAAAABnN0YXR1cwAAAAAH0AAAABRGaW5hbmNlUmVxdWVzdFN0YXR1cwAAAAAAAAAIc3VwcGxpZXIAAAAT",
        "AAAAAQAAAU9UaGUgc2luZ2xlIGFjdGl2ZSByZXBheW1lbnQgcG9zaXRpb24gZm9yIGEgbWlsZXN0b25lLgoKQXQgbW9zdCBvbmUgYEFjdGl2ZWAgcG9zaXRpb24gbWF5IGV4aXN0IHBlciBtaWxlc3RvbmUgKGludmFyaWFudCAxKS4gVGhlCnByaW5jaXBhbCByZWNvcmRlZCBoZXJlIHdhcyB0cmFuc2ZlcnJlZCAqKmZ1bmRlciDihpIgc3VwcGxpZXIqKiBmcm9tIHRoZQpmdW5kZXIncyBvd24gY2FwaXRhbDsgaXQgaXMgbmV2ZXIgZHJhd24gZnJvbSBidXllciBlc2Nyb3cgKGludmFyaWFudCAyNCkuCgpEZWNsYXJlZCBpbiBQS0ctMDE7IGNyZWF0ZWQgYW5kIG11dGF0ZWQgaW4gUEtHLTAzIC8gUEtHLTA0LgAAAAAAAAAAD0ZpbmFuY2VQb3NpdGlvbgAAAAAIAAAAAAAAAAlmdW5kZWRfYXQAAAAAAAAGAAAAAAAAAAZmdW5kZXIAAAAAABMAAAAAAAAADG1pbGVzdG9uZV9pZAAAAAYAAAAAAAAACG9mZmVyX2lkAAAABgAAAAAAAAAJcHJpbmNpcGFsAAAAAAAACwAAAAAAAAAJcmVwYXltZW50AAAAAAAACwAAAAAAAAAGc3RhdHVzAAAAAAfQAAAAFUZpbmFuY2VQb3NpdGlvblN0YXR1cwAAAAAAAAAAAAAIc3VwcGxpZXIAAAAT",
        "AAAAAwAAAjxNaWxlc3RvbmUgbGlmZWN5Y2xlIChBR0VOVC5tZCDCpzE3KS4KCmBgYHRleHQKZmluYW5jZWQ6ICAgVU5GVU5ERUQg4oaSIEZVTkRFRCDihpIgRklOQU5DRV9SRVFVRVNURUQg4oaSIEZJTkFOQ0VECuKGkiBTVUJNSVRURUQg4oaSIFZFUklGSUVEIOKGkiBTRVRUTEVECnVuZmluYW5jZWQ6IFVORlVOREVEIOKGkiBGVU5ERUQg4oaSIFNVQk1JVFRFRCDihpIgVkVSSUZJRUQg4oaSIFNFVFRMRUQKZGlzcHV0ZTogICAgRlVOREVEIHwgRklOQU5DRUQgfCBTVUJNSVRURUQg4oaSIERJU1BVVEVEIOKGkiBWRVJJRklFRCB8IFJFRlVOREVECmBgYAoKVGhlIGZ1bGwgdm9jYWJ1bGFyeSBpcyBkZWZpbmVkIGhlcmUgc28gbGF0ZXIgcGFja2FnZXMgY2Fubm90IGludmVudCBzdGF0ZXMuClBLRy0wMSBvbmx5IGV2ZXIgcHJvZHVjZXMgYFVuZnVuZGVkYC4KCmBERUxBWUVEYCAvIGBORUVEU19SRVZJRVdgIGFyZSBkZWxpYmVyYXRlbHkgKiphYnNlbnQqKjogcGVyIGludmFyaWFudCAyNiB0aGV5CmFyZSBkZXJpdmVkIHJlYWQtbW9kZWwvVUkgc3RhdHVzZXMgYW5kIG11c3QgbmV2ZXIgYmVjb21lIGNvbnRyYWN0IHN0YXRlLgAAAAAAAAAPTWlsZXN0b25lU3RhdHVzAAAAAAkAAAAAAAAACFVuZnVuZGVkAAAAAAAAAAAAAAAGRnVuZGVkAAAAAAABAAAAAAAAABBGaW5hbmNlUmVxdWVzdGVkAAAAAgAAAAAAAAAIRmluYW5jZWQAAAADAAAAAAAAAAlTdWJtaXR0ZWQAAAAAAAAEAAAAAAAAAAhWZXJpZmllZAAAAAUAAAAAAAAACERpc3B1dGVkAAAABgAAAAAAAAAHU2V0dGxlZAAAAAAHAAAAAAAAAAhSZWZ1bmRlZAAAAAg=",
        "AAAAAwAAAJNSZXNvbHV0aW9uIGNob3NlbiBieSB0aGUgYXNzaWduZWQgcmVzb2x2ZXIsIHVzZWQgYXMgdGhlIGByZXNvbHZlX2Rpc3B1dGVgCnBhcmFtZXRlciBpbiBQS0ctMDQuIFBhcnRpYWwgc2V0dGxlbWVudCBpcyBleHBsaWNpdGx5IG91dCBvZiBzY29wZSAowqc4KS4AAAAAAAAAABFEaXNwdXRlUmVzb2x1dGlvbgAAAAAAAAIAAAAAAAAABlNldHRsZQAAAAAAAAAAAAAAAAAGUmVmdW5kAAAAAAAB",
        "AAAAAwAAAAAAAAAAAAAAFEZpbmFuY2VSZXF1ZXN0U3RhdHVzAAAAAwAAAAAAAAAET3BlbgAAAAAAAAAAAAAACEFjY2VwdGVkAAAAAQAAAAAAAAAJQ2FuY2VsbGVkAAAAAAAAAg==",
        "AAAAAwAAAT5MaWZlY3ljbGUgb2YgYSBmdW5kZXIncyByZXBheW1lbnQgcG9zaXRpb24uCgpgQ2xvc2VkYCBtZWFucyB0aGUgcG9zaXRpb24gZW5kZWQgKip3aXRob3V0KiogcmVwYXltZW50IGZyb20gbWlsZXN0b25lCmVzY3JvdyDigJQgdGhlIHJlZnVuZCBwYXRoLiBUaGUgZnVuZGVyJ3MgYWR2YW5jZSBpcyBub3QgY2xhd2VkIGJhY2sgYW5kIHRoZQpzdXBwbGllciBrZWVwcyBpdDsgd2hhdGV2ZXIgY2xhaW0gdGhlIGZ1bmRlciByZXRhaW5zIGFnYWluc3QgdGhlIHN1cHBsaWVyIGlzCmFuIG9mZi1jaGFpbiBtYXR0ZXIgdGhpcyBjb250cmFjdCBkb2VzIG5vdCBtb2RlbC4AAAAAAAAAAAAVRmluYW5jZVBvc2l0aW9uU3RhdHVzAAAAAAAAAwAAAAAAAAAGQWN0aXZlAAAAAAAAAAAAAAAAAAZSZXBhaWQAAAAAAAEAAAAAAAAABkNsb3NlZAAAAAAAAg==",
        "AAAABAAAAOxFeHBsaWNpdCwgc3RhYmxlIGVycm9yIGNvZGVzIGZvciBgTWlsdmFuY2VDb3JlYC4KCkNvZGVzIGFyZSBwYXJ0IG9mIHRoZSBjb250cmFjdCBzdXJmYWNlOiBuZXZlciByZW51bWJlciBhbiBleGlzdGluZyB2YXJpYW50LApvbmx5IGFwcGVuZC4gT2ZmLWNoYWluIGNsaWVudHMgKFBLRy0wNSBiaW5kaW5ncywgUEtHLTA4IGluZGV4ZXIsIFBLRy0wOSBVSSkKbWFwIHRoZXNlIHRvIHVzZXItZmFjaW5nIG1lc3NhZ2VzLgAAAAAAAAAFRXJyb3IAAAAAAAAuAAAAAAAAAA5Ob3RJbml0aWFsaXplZAAAAAAAAQAAAAAAAAAMVW5hdXRob3JpemVkAAAAAgAAAAAAAAANT3JkZXJOb3RGb3VuZAAAAAAAAAoAAAAAAAAAEU1pbGVzdG9uZU5vdEZvdW5kAAAAAAAACwAAAAAAAAASSW52YWxpZE9yZGVyU3RhdHVzAAAAAAAUAAAAAAAAABZJbnZhbGlkTWlsZXN0b25lU3RhdHVzAAAAAAAVAAAAAAAAABRPcmRlckhhc05vTWlsZXN0b25lcwAAABYAAAAAAAAADkludmFsaWRQYXJ0aWVzAAAAAAAeAAAAAAAAAA9JbnZhbGlkQXR0ZXN0b3IAAAAAHwAAAAAAAAAPSW52YWxpZFJlc29sdmVyAAAAACAAAAAAAAAADUludmFsaWRBbW91bnQAAAAAAAAhAAAAAAAAAA9JbnZhbGlkRGVhZGxpbmUAAAAAIgAAAAAAAAAVTWlsZXN0b25lTGltaXRSZWFjaGVkAAAAAAAAIwAAAAAAAAAYQXR0ZXN0b3JSZXNvbHZlckNvbmZsaWN0AAAAJAAAAEZUaGUgYXNzZXQgc3VwcGxpZWQgYnkgdGhlIGNhbGxlciBpcyBub3QgdGhpcyBvcmRlcidzIHNldHRsZW1lbnQgYXNzZXQuAAAAAAAMSW52YWxpZEFzc2V0AAAAKAAAAEJUaGUgZGVwb3NpdCB3b3VsZCBwdXNoIGVzY3JvdyBwYXN0IHRoZSBwcm90ZWN0ZWQgbWlsZXN0b25lIGFtb3VudC4AAAAAAApPdmVyZnVuZGVkAAAAAAApAAAAQEEgcmVsZWFzZSB3b3VsZCBleGNlZWQgdGhlIGVzY3JvdyB0aGlzIG1pbGVzdG9uZSBhY3R1YWxseSBob2xkcy4AAAASSW5zdWZmaWNpZW50RXNjcm93AAAAAAAqAAAAAAAAABJBcml0aG1ldGljT3ZlcmZsb3cAAAAAACsAAAAAAAAAFkZpbmFuY2VSZXF1ZXN0Tm90Rm91bmQAAAAAADIAAAA5QSBsaXZlIGZpbmFuY2UgcmVxdWVzdCBhbHJlYWR5IGV4aXN0cyBmb3IgdGhpcyBtaWxlc3RvbmUuAAAAAAAAFEZpbmFuY2VSZXF1ZXN0QWN0aXZlAAAAMwAAAAAAAAAVRmluYW5jZVJlcXVlc3RFeHBpcmVkAAAAAAAANAAAAAAAAAAbSW52YWxpZEZpbmFuY2VSZXF1ZXN0U3RhdHVzAAAAADUAAABfVGhlIG1pbGVzdG9uZSBkb2VzIG5vdCBob2xkIGl0cyBmdWxsIHByb3RlY3RlZCBhbW91bnQsIHNvIGl0IGlzIG5vdApmaW5hbmNlYWJsZSAoaW52YXJpYW50IDIzKS4AAAAAF01pbGVzdG9uZU5vdEZ1bGx5RnVuZGVkAAAAADYAAAAAAAAADU9mZmVyTm90Rm91bmQAAAAAAAA3AAAAAAAAABJJbnZhbGlkT2ZmZXJTdGF0dXMAAAAAADgAAAAAAAAADE9mZmVyRXhwaXJlZAAAADkAAABgT2ZmZXJzIG11c3QgbWF0Y2ggdGhlIHJlcXVlc3RlZCBwcmluY2lwYWwgZXhhY3RseSwgc28gY29tcGV0aW5nIG9mZmVycwpkaWZmZXIgb25seSBpbiByZXBheW1lbnQuAAAAEVByaW5jaXBhbE1pc21hdGNoAAAAAAAAOgAAABhgcmVwYXltZW50IDwgcHJpbmNpcGFsYC4AAAAQSW52YWxpZFJlcGF5bWVudAAAADsAAAA0YHJlcGF5bWVudCA+IGZ1bmRlZCBtaWxlc3RvbmUgYW1vdW50YCAoaW52YXJpYW50IDIpLgAAABZSZXBheW1lbnRFeGNlZWRzRXNjcm93AAAAAAA8AAAAAAAAABFPZmZlckxpbWl0UmVhY2hlZAAAAAAAAD0AAABJVGhlIGZ1bmRlciBtdXN0IGJlIGluZGVwZW5kZW50IG9mIGJ1eWVyLCBzdXBwbGllciwgYXR0ZXN0b3IgYW5kIHJlc29sdmVyLgAAAAAAAA1JbnZhbGlkRnVuZGVyAAAAAAAAPgAAAAAAAAAPTm9BY2NlcHRlZE9mZmVyAAAAAD8AAABKQW4gQUNUSVZFIEZpbmFuY2VQb3NpdGlvbiBhbHJlYWR5IGV4aXN0cyBmb3IgdGhpcyBtaWxlc3RvbmUgKGludmFyaWFudCAxKS4AAAAAAA9BbHJlYWR5RmluYW5jZWQAAAAAQAAAAAAAAAAXRmluYW5jZVBvc2l0aW9uTm90Rm91bmQAAAAAQQAAAEBBbiBleHBpcnkgdGltZXN0YW1wIGlzIGluIHRoZSBwYXN0IG9yIGJleW9uZCB0aGUgYWxsb3dlZCB3aW5kb3cuAAAADUludmFsaWRFeHBpcnkAAAAAAABCAAAAgURlZmVuc2l2ZTogdGhlIGZ1bmRlciBhZHZhbmNlIGFsdGVyZWQgYnV5ZXIgbWlsZXN0b25lIGVzY3Jvdy4gVGhpcyBtdXN0CmJlIHVucmVhY2hhYmxlOyByZWFjaGluZyBpdCByZXZlcnRzIHRoZSB3aG9sZSBpbnZvY2F0aW9uLgAAAAAAAA1Fc2Nyb3dNdXRhdGVkAAAAAAAAQwAAAEFUaGUgYWNjZXB0ZWQgb2ZmZXIgaGFzIG5vdCBleHBpcmVkIHlldCwgc28gaXQgY2Fubm90IGJlIHJlbGVhc2VkLgAAAAAAAA5PZmZlclN0aWxsTGl2ZQAAAAAARAAAADJObyBldmlkZW5jZSBoYXMgYmVlbiBjb21taXR0ZWQgZm9yIHRoaXMgbWlsZXN0b25lLgAAAAAAEEV2aWRlbmNlTm90Rm91bmQAAABGAAAAQlRoZSBhdHRlc3RvciBzaWduZWQgZm9yIGEgZGlmZmVyZW50IGRpZ2VzdCB0aGFuIHRoZSBvbmUgb24gcmVjb3JkLgAAAAAAEEV2aWRlbmNlTWlzbWF0Y2gAAABHAAAANEFuIGFsbC16ZXJvIGRpZ2VzdCBpcyByZWplY3RlZCBhcyBhbiB1bnNldCBzZW50aW5lbC4AAAAPSW52YWxpZEV2aWRlbmNlAAAAAEgAAAAAAAAAD0Rpc3B1dGVOb3RGb3VuZAAAAABJAAAAAAAAABJEaXNwdXRlQWxyZWFkeU9wZW4AAAAAAEoAAAAAAAAAFEludmFsaWREaXNwdXRlU3RhdHVzAAAASwAAADNUaGUgbWlsZXN0b25lIGhvbGRzIG5vIGVzY3JvdyB0byBwYXkgb3V0IG9yIHJldHVybi4AAAAAD05vdGhpbmdUb1NldHRsZQAAAABMAAAAMFRoZSBtaWxlc3RvbmUgaG9sZHMgbm8gcGFydGlhbCBlc2Nyb3cgdG8gdW53aW5kLgAAABBOb1BhcnRpYWxGdW5kaW5nAAAATQAAAEdBbiBvZmZlciBoYXMgYWxyZWFkeSBiZWVuIHNlbGVjdGVkLCBzbyB0aGUgcmVxdWVzdCBjYW5ub3QgYmUgY2FuY2VsbGVkLgAAAAAUT2ZmZXJBbHJlYWR5QWNjZXB0ZWQAAABO",
        "AAAABQAAAAAAAAAAAAAADE9yZGVyQ3JlYXRlZAAAAAEAAAANb3JkZXJfY3JlYXRlZAAAAAAAAAYAAAAAAAAACG9yZGVyX2lkAAAABgAAAAEAAAAAAAAABWJ1eWVyAAAAAAAAEwAAAAAAAAAAAAAACHN1cHBsaWVyAAAAEwAAAAAAAAAAAAAACGF0dGVzdG9yAAAAEwAAAAAAAAAAAAAACHJlc29sdmVyAAAAEwAAAAAAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAAAAAAC",
        "AAAABQAAAR1Xb3JraW5nIGNhcGl0YWwgbW92ZWQgKipmdW5kZXIg4oaSIHN1cHBsaWVyKiogZnJvbSB0aGUgZnVuZGVyJ3Mgb3duIGNhcGl0YWwuCgpgcHJvdGVjdGVkX2Ftb3VudGAgaXMgZW1pdHRlZCBhbG9uZ3NpZGUgc28gYW55IGluZGV4ZXIgb3IgYXVkaXRvciBjYW4gc2VlCnRoYXQgYnV5ZXIgZXNjcm93IHdhcyB1bnRvdWNoZWQgYnkgdGhpcyB0cmFuc2ZlcjogdGhlIGFkdmFuY2UgaXMgbm90IGRyYXduCmZyb20gaXQsIGFuZCB0aGUgbWlsZXN0b25lJ3MgcHJvdGVjdGVkIHRvdGFsIGlzIHVuY2hhbmdlZC4AAAAAAAAAAAAADUFkdmFuY2VGdW5kZWQAAAAAAAABAAAADmFkdmFuY2VfZnVuZGVkAAAAAAAHAAAAAAAAAAxtaWxlc3RvbmVfaWQAAAAGAAAAAQAAAAAAAAAIb2ZmZXJfaWQAAAAGAAAAAQAAAAAAAAAGZnVuZGVyAAAAAAATAAAAAAAAAAAAAAAIc3VwcGxpZXIAAAATAAAAAAAAADRUcmFuc2ZlcnJlZCBmcm9tIGZ1bmRlciBjYXBpdGFsIHRvIHRoZSBzdXBwbGllciBub3cuAAAACXByaW5jaXBhbAAAAAAAAAsAAAAAAAAAQE93ZWQgdG8gdGhlIGZ1bmRlciBmaXJzdCBvdXQgb2YgdmVyaWZpZWQgbWlsZXN0b25lIGVzY3JvdyBsYXRlci4AAAAJcmVwYXltZW50AAAAAAAACwAAAAAAAAA/QnV5ZXIgZXNjcm93IHByb3RlY3RpbmcgdGhpcyBtaWxlc3RvbmUsIHVuY2hhbmdlZCBieSB0aGlzIGNhbGwuAAAAABBwcm90ZWN0ZWRfYW1vdW50AAAACwAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADURpc3B1dGVPcGVuZWQAAAAAAAABAAAADmRpc3B1dGVfb3BlbmVkAAAAAAAEAAAAAAAAAAxtaWxlc3RvbmVfaWQAAAAGAAAAAQAAAAAAAAAKZGlzcHV0ZV9pZAAAAAAABgAAAAEAAAAAAAAACW9wZW5lZF9ieQAAAAAAABMAAAAAAAAAAAAAAAhyZXNvbHZlcgAAABMAAAAAAAAAAg==",
        "AAAABQAAAEpUaGUgc3VwcGxpZXIgc2VsZWN0ZWQgb25lIG9mZmVyLiBJdHMgZWNvbm9taWNzIGFyZSBmcm96ZW4gZnJvbSB0aGlzIHBvaW50LgAAAAAAAAAAAA1PZmZlckFjY2VwdGVkAAAAAAAAAQAAAA5vZmZlcl9hY2NlcHRlZAAAAAAABQAAAAAAAAAMbWlsZXN0b25lX2lkAAAABgAAAAEAAAAAAAAACG9mZmVyX2lkAAAABgAAAAEAAAAAAAAABmZ1bmRlcgAAAAAAEwAAAAAAAAAAAAAACXByaW5jaXBhbAAAAAAAAAsAAAAAAAAAAAAAAAlyZXBheW1lbnQAAAAAAAALAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADU9yZGVyQWNjZXB0ZWQAAAAAAAABAAAADm9yZGVyX2FjY2VwdGVkAAAAAAACAAAAAAAAAAhvcmRlcl9pZAAAAAYAAAABAAAAAAAAAAhzdXBwbGllcgAAABMAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADk9yZGVyQ2FuY2VsbGVkAAAAAAABAAAAD29yZGVyX2NhbmNlbGxlZAAAAAACAAAAAAAAAAhvcmRlcl9pZAAAAAYAAAABAAAAAAAAAAVidXllcgAAAAAAABMAAAAAAAAAAg==",
        "AAAABQAAADZFdmVyeSBtaWxlc3RvbmUgb24gdGhlIG9yZGVyIHJlYWNoZWQgYSB0ZXJtaW5hbCBzdGF0ZS4AAAAAAAAAAAAOT3JkZXJDb21wbGV0ZWQAAAAAAAEAAAAPb3JkZXJfY29tcGxldGVkAAAAAAEAAAAAAAAACG9yZGVyX2lkAAAABgAAAAEAAAAC",
        "AAAABQAAAAAAAAAAAAAAD0Rpc3B1dGVSZXNvbHZlZAAAAAABAAAAEGRpc3B1dGVfcmVzb2x2ZWQAAAAEAAAAAAAAAAxtaWxlc3RvbmVfaWQAAAAGAAAAAQAAAAAAAAAKZGlzcHV0ZV9pZAAAAAAABgAAAAEAAAAAAAAACHJlc29sdmVyAAAAEwAAAAAAAABCVHJ1ZSBmb3IgU0VUVExFIChtaWxlc3RvbmUgcmV0dXJucyB0byB2ZXJpZmllZCksIGZhbHNlIGZvciBSRUZVTkQuAAAAAAAHc2V0dGxlZAAAAAABAAAAAAAAAAI=",
        "AAAABQAAAVpCdXllciBlc2Nyb3cgd2FzIGFkZGVkIHRvIGEgbWlsZXN0b25lLgoKYGFtb3VudGAgaXMgdGhpcyBkZXBvc2l0OyBgZnVuZGVkX2Ftb3VudGAgaXMgdGhlIG1pbGVzdG9uZSdzIGN1bXVsYXRpdmUKcHJvdGVjdGVkIHRvdGFsLiBgZnVsbHlfZnVuZGVkYCByZXBvcnRzIHdoZXRoZXIgdGhlIG1pbGVzdG9uZSBub3cgaG9sZHMgaXRzCmZ1bGwgcHJvdGVjdGVkIGFtb3VudCwgd2hpY2ggaXMgdGhlIE1WUCBmaW5hbmNlYWJpbGl0eSBwcmVjb25kaXRpb24uCgpUaGlzIGV2ZW50IHJlY29yZHMgKipidXllciBtb25leSBlbnRlcmluZyBwcm90ZWN0aW9uKiosIG5ldmVyIGEgcGF5bWVudCB0bwp0aGUgc3VwcGxpZXIuAAAAAAAAAAAAD01pbGVzdG9uZUZ1bmRlZAAAAAABAAAAEG1pbGVzdG9uZV9mdW5kZWQAAAAGAAAAAAAAAAhvcmRlcl9pZAAAAAYAAAABAAAAAAAAAAxtaWxlc3RvbmVfaWQAAAAGAAAAAQAAAAAAAAAFYnV5ZXIAAAAAAAATAAAAAAAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAAAAAANZnVuZGVkX2Ftb3VudAAAAAAAAAsAAAAAAAAAAAAAAAxmdWxseV9mdW5kZWQAAAABAAAAAAAAAAI=",
        "AAAABQAAAFZUaGUgc3VwcGxpZXIgb3BlbmVkIGEgcmVxdWVzdCBmb3Igd29ya2luZyBjYXBpdGFsIGFnYWluc3QgYSBmdWxseSBwcm90ZWN0ZWQKbWlsZXN0b25lLgAAAAAAAAAAABBGaW5hbmNlUmVxdWVzdGVkAAAAAQAAABFmaW5hbmNlX3JlcXVlc3RlZAAAAAAAAAUAAAAAAAAADG1pbGVzdG9uZV9pZAAAAAYAAAABAAAAAAAAAAhzdXBwbGllcgAAABMAAAAAAAAAAAAAABNyZXF1ZXN0ZWRfcHJpbmNpcGFsAAAAAAsAAAAAAAAAQFRoZSBwcm90ZWN0ZWQgbWlsZXN0b25lIGVzY3JvdyBhIGZ1bmRlciBpcyB1bmRlcndyaXRpbmcgYWdhaW5zdC4AAAAQcHJvdGVjdGVkX2Ftb3VudAAAAAsAAAAAAAAAAAAAAApleHBpcmVzX2F0AAAAAAAGAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAEE1pbGVzdG9uZUNyZWF0ZWQAAAABAAAAEW1pbGVzdG9uZV9jcmVhdGVkAAAAAAAABQAAAAAAAAAIb3JkZXJfaWQAAAAGAAAAAQAAAAAAAAAMbWlsZXN0b25lX2lkAAAABgAAAAEAAAAAAAAABWluZGV4AAAAAAAABAAAAAAAAABbUHJvdGVjdGVkIG1pbGVzdG9uZSBwYXltZW50IHRoZSBidXllciBjb21taXRzIHRvIGVzY3JvdyBsYXRlci4KUmVjb3JkaW5nIGl0IG1vdmVzIG5vIHZhbHVlLgAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAAAAAAIZGVhZGxpbmUAAAPoAAAABgAAAAAAAAAC",
        "AAAABQAAACxQcm90ZWN0ZWQgZXNjcm93IHdhcyBwYWlkIG91dCwgZnVuZGVyIGZpcnN0LgAAAAAAAAAQTWlsZXN0b25lU2V0dGxlZAAAAAEAAAARbWlsZXN0b25lX3NldHRsZWQAAAAAAAAFAAAAAAAAAAhvcmRlcl9pZAAAAAYAAAABAAAAAAAAAAxtaWxlc3RvbmVfaWQAAAAGAAAAAQAAAEZFc2Nyb3cgcmVsZWFzZWQgaW4gdG90YWw7IGVxdWFscyBgZnVuZGVyX3JlcGF5bWVudCArIHN1cHBsaWVyX3BheW91dGAuAAAAAAAQcHJvdGVjdGVkX2Ftb3VudAAAAAsAAAAAAAAAQ1JlcGFpZCB0byB0aGUgZnVuZGVyIGZpcnN0LiBaZXJvIHdoZW4gdGhlIG1pbGVzdG9uZSB3YXMgdW5maW5hbmNlZC4AAAAAEGZ1bmRlcl9yZXBheW1lbnQAAAALAAAAAAAAADlUaGUgc3VwcGxpZXIncyByZW1haW5kZXIgYWZ0ZXIgdGhlIGZ1bmRlciB3YXMgbWFkZSB3aG9sZS4AAAAAAAAPc3VwcGxpZXJfcGF5b3V0AAAAAAsAAAAAAAAAAg==",
        "AAAABQAAATRUaGUgc3VwcGxpZXIgY29tbWl0dGVkIGEgU0hBLTI1NiBkaWdlc3Qgb2YgdGhlIG9mZi1jaGFpbiBldmlkZW5jZS4KCk9ubHkgdGhlIGRpZ2VzdCBpcyBlbWl0dGVkLiBSYXcgZG9jdW1lbnRzIGFuZCBhbnkgS1lDIG1hdGVyaWFsIHN0YXkKb2ZmLWNoYWluLCBhbmQgdGhlIGNvbnRyYWN0IGF0dGFjaGVzIG5vIG1lYW5pbmcgdG8gd2hhdCB0aGUgZGlnZXN0IGNvdmVycyDigJQKcHJvZHVjdGlvbiBwaG90b3MsIGEgYmlsbCBvZiBsYWRpbmcgb3IgYSBkZWxpdmVyeSBjb25maXJtYXRpb24gYXJlIGFsbCB0aGUKc2FtZSAzMiBieXRlcyBoZXJlLgAAAAAAAAARRXZpZGVuY2VTdWJtaXR0ZWQAAAAAAAABAAAAEmV2aWRlbmNlX3N1Ym1pdHRlZAAAAAAABAAAAAAAAAAMbWlsZXN0b25lX2lkAAAABgAAAAEAAAAAAAAACHN1cHBsaWVyAAAAEwAAAAAAAAAAAAAADWV2aWRlbmNlX2hhc2gAAAAAAAPuAAAAIAAAAAAAAABAVHJ1ZSB3aGVuIHRoaXMgcmVwbGFjZWQgYW4gZWFybGllciwgbm90LXlldC12ZXJpZmllZCBzdWJtaXNzaW9uLgAAABFyZXBsYWNlZF9wcmV2aW91cwAAAAAAAAEAAAAAAAAAAg==",
        "AAAABQAAAORFc2Nyb3cgd2FzIHJldHVybmVkIHRvIHRoZSBidXllciBhZnRlciBhIFJFRlVORCByZXNvbHV0aW9uLgoKYGZ1bmRlcl9hZHZhbmNlX291dHN0YW5kaW5nYCByZWNvcmRzIHRoYXQgYSBmdW5kZXIncyBhZHZhbmNlIHdhcyAqKm5vdCoqCnJldmVyc2VkIGJ5IHRoaXMgcmVmdW5kOiB0aGUgc3VwcGxpZXIga2VlcHMgaXQsIGFuZCB0aGUgZnVuZGVyJ3MgY2xhaW0gaXMgYW4Kb2ZmLWNoYWluIG1hdHRlci4AAAAAAAAAEU1pbGVzdG9uZVJlZnVuZGVkAAAAAAAAAQAAABJtaWxlc3RvbmVfcmVmdW5kZWQAAAAAAAUAAAAAAAAACG9yZGVyX2lkAAAABgAAAAEAAAAAAAAADG1pbGVzdG9uZV9pZAAAAAYAAAABAAAAAAAAAAVidXllcgAAAAAAABMAAAAAAAAAAAAAAA9yZWZ1bmRlZF9hbW91bnQAAAAACwAAAAAAAAAAAAAAGmZ1bmRlcl9hZHZhbmNlX291dHN0YW5kaW5nAAAAAAALAAAAAAAAAAI=",
        "AAAABQAAAEdUaGUgYXNzaWduZWQgYXR0ZXN0b3IgdmVyaWZpZWQgdGhlIG1pbGVzdG9uZSBhZ2FpbnN0IGEgc3BlY2lmaWMgZGlnZXN0LgAAAAAAAAAAEU1pbGVzdG9uZVZlcmlmaWVkAAAAAAAAAQAAABJtaWxlc3RvbmVfdmVyaWZpZWQAAAAAAAMAAAAAAAAADG1pbGVzdG9uZV9pZAAAAAYAAAABAAAAAAAAAAhhdHRlc3RvcgAAABMAAAAAAAAAAAAAAA1ldmlkZW5jZV9oYXNoAAAAAAAD7gAAACAAAAAAAAAAAg==",
        "AAAABQAAAYBUaGUgc3VwcGxpZXIgcmVsZWFzZWQgYW4gYWNjZXB0ZWQgb2ZmZXIgdGhhdCBleHBpcmVkIHdpdGhvdXQgdGhlIHNlbGVjdGVkCmZ1bmRlciBldmVyIGFkdmFuY2luZyBjYXBpdGFsLgoKTm8gdmFsdWUgbW92ZXMgd2hlbiB0aGlzIGlzIGVtaXR0ZWQ6IGJ1eWVyIGVzY3JvdyBpcyB1bnRvdWNoZWQgYW5kIG5vIGZ1bmRlcgpjYXBpdGFsIHdhcyBldmVyIGNvbW1pdHRlZC4gYHJlcXVlc3RfcmVvcGVuZWRgIGRpc3Rpbmd1aXNoZXMgdGhlIHR3bwpyZWNvdmVyaWVzIOKAlCB0aGUgZmluYW5jZSByZXF1ZXN0IHdhcyBzdGlsbCBsaXZlIGFuZCBpcyB1c2FibGUgYWdhaW4sIG9yIGl0CmhhZCBleHBpcmVkIHRvbyBhbmQgdGhlIG1pbGVzdG9uZSByZXR1cm5lZCB0byBgRnVuZGVkYC4AAAAAAAAAEkFjY2VwdGFuY2VSZWxlYXNlZAAAAAAAAQAAABNhY2NlcHRhbmNlX3JlbGVhc2VkAAAAAAUAAAAAAAAADG1pbGVzdG9uZV9pZAAAAAYAAAABAAAAAAAAAAhvZmZlcl9pZAAAAAYAAAABAAAAAAAAAAhzdXBwbGllcgAAABMAAAAAAAAALlRoZSBmdW5kZXIgdGhhdCB3YXMgc2VsZWN0ZWQgYnV0IG5ldmVyIGZ1bmRlZC4AAAAAAAZmdW5kZXIAAAAAABMAAAAAAAAAAAAAABByZXF1ZXN0X3Jlb3BlbmVkAAAAAQAAAAAAAAAC",
        "AAAABQAAADtBIGZ1bmRlciBwcmljZWQgdGhlIHJlcXVlc3QuIE9mZmVycyBjb21wZXRlIG9uIGByZXBheW1lbnRgLgAAAAAAAAAAE0Z1bmRpbmdPZmZlckNyZWF0ZWQAAAAAAQAAABVmdW5kaW5nX29mZmVyX2NyZWF0ZWQAAAAAAAAGAAAAAAAAAAxtaWxlc3RvbmVfaWQAAAAGAAAAAQAAAAAAAAAIb2ZmZXJfaWQAAAAGAAAAAQAAAAAAAAAGZnVuZGVyAAAAAAATAAAAAAAAAAAAAAAJcHJpbmNpcGFsAAAAAAAACwAAAAAAAAAAAAAACXJlcGF5bWVudAAAAAAAAAsAAAAAAAAAAAAAAApleHBpcmVzX2F0AAAAAAAGAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAFUZ1bmRpbmdPZmZlckNhbmNlbGxlZAAAAAAAAAEAAAAXZnVuZGluZ19vZmZlcl9jYW5jZWxsZWQAAAAAAwAAAAAAAAAMbWlsZXN0b25lX2lkAAAABgAAAAEAAAAAAAAACG9mZmVyX2lkAAAABgAAAAEAAAAAAAAABmZ1bmRlcgAAAAAAEwAAAAAAAAAC",
        "AAAABQAAAOlUaGUgc3VwcGxpZXIgY2xvc2VkIGEgZmluYW5jZSByZXF1ZXN0IHRoYXQgbmV2ZXIgcHJvZHVjZWQgYSBmdW5kZWQgYWR2YW5jZS4KClRoZSBtaWxlc3RvbmUgcmV0dXJucyB0byBgRnVuZGVkYCDigJQgc3RpbGwgZnVsbHkgcHJvdGVjdGVkLCBzaW1wbHkgbm8gbG9uZ2VyCnNlZWtpbmcgZmluYW5jaW5nLiBObyB2YWx1ZSBtb3ZlczogYSByZXF1ZXN0IGlzIGFuIGludml0YXRpb24sIG5vdCBhCnRyYW5zZmVyLgAAAAAAAAAAAAAXRmluYW5jZVJlcXVlc3RDYW5jZWxsZWQAAAAAAQAAABlmaW5hbmNlX3JlcXVlc3RfY2FuY2VsbGVkAAAAAAAAAwAAAAAAAAAMbWlsZXN0b25lX2lkAAAABgAAAAEAAAAAAAAACHN1cHBsaWVyAAAAEwAAAAAAAABFVHJ1ZSB3aGVuIHRoZSByZXF1ZXN0IGhhZCBhbHJlYWR5IGxhcHNlZCByYXRoZXIgdGhhbiBiZWluZyB3aXRoZHJhd24uAAAAAAAAC3dhc19leHBpcmVkAAAAAAEAAAAAAAAAAg==",
        "AAAABQAAAPNUaGUgYnV5ZXIgdW53b3VuZCBhbiBpbmNvbXBsZXRlIGZ1bmRpbmcgYXR0ZW1wdC4KCkVtaXR0ZWQgb25seSB3aGlsZSB0aGUgbWlsZXN0b25lIGlzIHN0aWxsIHNob3J0IG9mIGl0cyBwcm90ZWN0ZWQgYW1vdW50LiBObwpmaW5hbmNpbmcgZXhpc3RzIGF0IHRoaXMgcG9pbnQsIHNvIG5vdGhpbmcgYnV0IHRoZSBidXllcidzIG93biBwYXJ0aWFsCmRlcG9zaXQgbW92ZXMsIGFuZCBpdCBtb3ZlcyBiYWNrIHRvIHRoZSBidXllci4AAAAAAAAAABdQYXJ0aWFsRnVuZGluZ0NhbmNlbGxlZAAAAAABAAAAGXBhcnRpYWxfZnVuZGluZ19jYW5jZWxsZWQAAAAAAAAEAAAAAAAAAAhvcmRlcl9pZAAAAAYAAAABAAAAAAAAAAxtaWxlc3RvbmVfaWQAAAAGAAAAAQAAAAAAAAAFYnV5ZXIAAAAAAAATAAAAAAAAAEVUaGUgcGFydGlhbCBlc2Nyb3cgcmV0dXJuZWQ7IHRoZSBtaWxlc3RvbmUgZHJvcHMgYmFjayB0byB6ZXJvIGZ1bmRlZC4AAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAI=" ]),
      options
    )
  }
  public readonly fromJSON = {
    get_offer: this.txFromJSON<Result<FundingOffer>>,
        get_order: this.txFromJSON<Result<Order>>,
        get_config: this.txFromJSON<Result<Config>>,
        make_offer: this.txFromJSON<Result<u64>>,
        offer_count: this.txFromJSON<u64>,
        order_count: this.txFromJSON<u64>,
        accept_offer: this.txFromJSON<Result<void>>,
        accept_order: this.txFromJSON<Result<void>>,
        cancel_offer: this.txFromJSON<Result<void>>,
        cancel_order: this.txFromJSON<Result<void>>,
        create_order: this.txFromJSON<Result<u64>>,
        fund_advance: this.txFromJSON<Result<void>>,
        open_dispute: this.txFromJSON<Result<u64>>,
        dispute_count: this.txFromJSON<u64>,
        get_milestone: this.txFromJSON<Result<Milestone>>,
        fund_milestone: this.txFromJSON<Result<i128>>,
        get_open_offers: this.txFromJSON<Array<FundingOffer>>,
        is_fully_funded: this.txFromJSON<Result<boolean>>,
        milestone_count: this.txFromJSON<u64>,
        request_finance: this.txFromJSON<Result<void>>,
        resolve_dispute: this.txFromJSON<Result<void>>,
        submit_evidence: this.txFromJSON<Result<void>>,
        attest_milestone: this.txFromJSON<Result<void>>,
        create_milestone: this.txFromJSON<Result<u64>>,
        protocol_version: this.txFromJSON<u32>,
        settle_milestone: this.txFromJSON<Result<void>>,
        get_evidence_hash: this.txFromJSON<Result<Buffer>>,
        get_accepted_offer: this.txFromJSON<Result<FundingOffer>>,
        get_finance_request: this.txFromJSON<Result<FinanceRequest>>,
        get_finance_position: this.txFromJSON<Result<FinancePosition>>,
        get_order_milestones: this.txFromJSON<Result<Array<u64>>>,
        get_milestone_dispute: this.txFromJSON<Result<Dispute>>,
        cancel_finance_request: this.txFromJSON<Result<boolean>>,
        cancel_partial_funding: this.txFromJSON<Result<i128>>,
        get_milestone_offer_ids: this.txFromJSON<Array<u64>>,
        release_expired_acceptance: this.txFromJSON<Result<boolean>>,
        has_active_finance_position: this.txFromJSON<boolean>
  }
}
use soroban_sdk::{contracttype, Address};

/// Deterministic, monotonically increasing identifiers. Counters start at 1, so
/// `0` is never a valid id and can be treated as "unset" off-chain.
///
/// These aliases are for internal readability only and must **not** appear in
/// anything the contract spec exports — contract function signatures,
/// `#[contracttype]` fields or `#[contractevent]` fields. The spec records an
/// alias by name rather than resolving it, which makes generated bindings
/// reference a type that was never declared. Spec-visible identifiers are
/// therefore written as plain `u64`.
pub type OrderId = u64;
pub type MilestoneId = u64;
pub type OfferId = u64;
pub type DisputeId = u64;

/// Global protocol configuration (instance storage).
///
/// `admin` is an operational role only. Per AGENT.md §19 invariant 17 the admin
/// has **no** authority to move, withdraw or redirect user funds, and no function
/// in this contract grants it any. It exists to identify the deploying operator.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    /// Settlement asset contract (USDC SAC). MVP rejects any other asset.
    pub usdc: Address,
    pub protocol_version: u32,
}

// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------

/// Order lifecycle (AGENT.md §17).
///
/// ```text
/// CREATED → ACTIVE → COMPLETED
///    └───→ CANCELLED
/// ```
///
/// `Completed` is reached only when every milestone is terminal. That transition
/// depends on settlement and is therefore implemented in PKG-04, not here.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum OrderStatus {
    Created = 0,
    Active = 1,
    Completed = 2,
    Cancelled = 3,
}

/// A commercial order between one buyer and one supplier.
///
/// Every address field is assigned at creation and immutable afterwards: no
/// function in this contract mutates `buyer`, `supplier`, `attestor`, `resolver`
/// or `asset`. This is what makes "only the assigned attestor can verify"
/// (invariant 14) and "order asset is immutable" (invariant 19) enforceable.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Order {
    pub id: u64,
    /// Prefunds protected milestone escrow. Never the supplier's working capital.
    pub buyer: Address,
    pub supplier: Address,
    /// Authorized to verify milestone evidence (PKG-04).
    pub attestor: Address,
    /// Authorized to resolve a disputed milestone (PKG-04).
    pub resolver: Address,
    /// Settlement asset, snapshotted from `Config.usdc` at creation.
    pub asset: Address,
    pub status: OrderStatus,
    pub created_at: u64,
}

// ---------------------------------------------------------------------------
// Milestone
// ---------------------------------------------------------------------------

/// Milestone lifecycle (AGENT.md §17).
///
/// ```text
/// financed:   UNFUNDED → FUNDED → FINANCE_REQUESTED → FINANCED
///                      → SUBMITTED → VERIFIED → SETTLED
/// unfinanced: UNFUNDED → FUNDED → SUBMITTED → VERIFIED → SETTLED
/// dispute:    FUNDED | FINANCED | SUBMITTED → DISPUTED → VERIFIED | REFUNDED
/// ```
///
/// The full vocabulary is defined here so later packages cannot invent states.
/// PKG-01 only ever produces `Unfunded`.
///
/// `DELAYED` / `NEEDS_REVIEW` are deliberately **absent**: per invariant 26 they
/// are derived read-model/UI statuses and must never become contract state.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum MilestoneStatus {
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

/// A single protected production milestone.
///
/// The contract is intentionally generic: there is no label, carrier, port,
/// vessel or Bill of Lading field. A milestone meaning "QC + Handed to Carrier"
/// or "Delivery Confirmed" is labelled off-chain (AGENT.md §9A, §20). That keeps
/// the same state machine usable for raw materials, production, QC, shipment and
/// delivery without the contract knowing what a ship is.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Milestone {
    pub id: u64,
    pub order_id: u64,
    /// Position within the order, assigned in creation order.
    pub index: u32,
    /// Protected milestone payment the buyer commits to escrow, in asset units.
    pub amount: i128,
    /// Buyer escrow actually received so far. Mutated only by PKG-02.
    ///
    /// This is **buyer money held by the contract**, never a supplier balance.
    pub funded_amount: i128,
    /// Informational target date. Expiry alone must never move funds
    /// (invariant 25); it can only surface a derived status off-chain.
    pub deadline: Option<u64>,
    pub status: MilestoneStatus,
    pub created_at: u64,
}

// ---------------------------------------------------------------------------
// Financing domain — declared here, exercised in PKG-03 / PKG-04
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum FinanceRequestStatus {
    Open = 0,
    Accepted = 1,
    Cancelled = 2,
}

/// A supplier's request for working capital against a fully protected milestone.
///
/// Declared in PKG-01; created and mutated in PKG-03.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FinanceRequest {
    pub milestone_id: u64,
    pub supplier: Address,
    pub requested_principal: i128,
    pub status: FinanceRequestStatus,
    pub expires_at: u64,
    pub created_at: u64,
}

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum OfferStatus {
    Open = 0,
    Cancelled = 1,
    Accepted = 2,
    Funded = 3,
}

/// A competing funder's priced offer. Held in temporary storage while open
/// (AGENT.md §18); accepted economics are copied into a persistent
/// `FinancePosition` at funding time so they can never change afterwards.
///
/// Declared in PKG-01; created and mutated in PKG-03.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FundingOffer {
    pub id: u64,
    pub milestone_id: u64,
    pub funder: Address,
    /// Advanced to the supplier from the funder's own capital.
    pub principal: i128,
    /// Repaid to the funder first out of verified milestone escrow.
    pub repayment: i128,
    pub expires_at: u64,
    pub status: OfferStatus,
}

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum FinancePositionStatus {
    Active = 0,
    Repaid = 1,
    Closed = 2,
}

/// The single active repayment position for a milestone.
///
/// At most one `Active` position may exist per milestone (invariant 1). The
/// principal recorded here was transferred **funder → supplier** from the
/// funder's own capital; it is never drawn from buyer escrow (invariant 24).
///
/// Declared in PKG-01; created and mutated in PKG-03 / PKG-04.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FinancePosition {
    pub milestone_id: u64,
    pub offer_id: u64,
    pub funder: Address,
    pub supplier: Address,
    pub principal: i128,
    pub repayment: i128,
    pub status: FinancePositionStatus,
    pub funded_at: u64,
}

// ---------------------------------------------------------------------------
// Dispute
// ---------------------------------------------------------------------------

/// Dispute lifecycle. The resolution is encoded in the terminal status rather
/// than stored separately, so a resolved dispute can never carry a missing or
/// contradictory outcome.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum DisputeStatus {
    Open = 0,
    ResolvedSettle = 1,
    ResolvedRefund = 2,
}

/// Resolution chosen by the assigned resolver, used as the `resolve_dispute`
/// parameter in PKG-04. Partial settlement is explicitly out of scope (§8).
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum DisputeResolution {
    Settle = 0,
    Refund = 1,
}

/// A dispute over exactly one milestone.
///
/// Disputes are milestone-scoped so that freezing M4 cannot disturb already
/// settled M1–M3 (AGENT.md §9A.5).
///
/// Declared in PKG-01; created and mutated in PKG-04.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Dispute {
    pub id: u64,
    pub milestone_id: u64,
    pub opened_by: Address,
    pub resolver: Address,
    pub status: DisputeStatus,
    pub opened_at: u64,
}

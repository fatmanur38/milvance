//! Contract events (AGENT.md §20).
//!
//! Events are declared with `#[contractevent]` so they are included in the
//! contract spec: PKG-05 can generate typed bindings for them and the PKG-08
//! indexer can decode them without a hand-maintained schema.
//!
//! The struct name in lower snake case is the first topic, so `OrderCreated`
//! publishes under the topic `order_created`. Entity ids are marked `#[topic]`
//! to keep indexer filtering cheap.
//!
//! Two standing rules for every event added to this contract:
//!
//! - never emit raw evidence, document contents or KYC data,
//! - never emit carrier/shipment-specific events; shipment meaning is an
//!   off-chain label, not contract semantics.

use soroban_sdk::{contractevent, Address, BytesN};

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OrderCreated {
    #[topic]
    pub order_id: u64,
    pub buyer: Address,
    pub supplier: Address,
    pub attestor: Address,
    pub resolver: Address,
    pub asset: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OrderAccepted {
    #[topic]
    pub order_id: u64,
    pub supplier: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OrderCancelled {
    #[topic]
    pub order_id: u64,
    pub buyer: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MilestoneCreated {
    #[topic]
    pub order_id: u64,
    #[topic]
    pub milestone_id: u64,
    pub index: u32,
    /// Protected milestone payment the buyer commits to escrow later.
    /// Recording it moves no value.
    pub amount: i128,
    pub deadline: Option<u64>,
}

/// Buyer escrow was added to a milestone.
///
/// `amount` is this deposit; `funded_amount` is the milestone's cumulative
/// protected total. `fully_funded` reports whether the milestone now holds its
/// full protected amount, which is the MVP financeability precondition.
///
/// This event records **buyer money entering protection**, never a payment to
/// the supplier.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MilestoneFunded {
    #[topic]
    pub order_id: u64,
    #[topic]
    pub milestone_id: u64,
    pub buyer: Address,
    pub amount: i128,
    pub funded_amount: i128,
    pub fully_funded: bool,
}

/// The supplier opened a request for working capital against a fully protected
/// milestone.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FinanceRequested {
    #[topic]
    pub milestone_id: u64,
    pub supplier: Address,
    pub requested_principal: i128,
    /// The protected milestone escrow a funder is underwriting against.
    pub protected_amount: i128,
    pub expires_at: u64,
}

/// A funder priced the request. Offers compete on `repayment`.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FundingOfferCreated {
    #[topic]
    pub milestone_id: u64,
    #[topic]
    pub offer_id: u64,
    pub funder: Address,
    pub principal: i128,
    pub repayment: i128,
    pub expires_at: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FundingOfferCancelled {
    #[topic]
    pub milestone_id: u64,
    #[topic]
    pub offer_id: u64,
    pub funder: Address,
}

/// The supplier selected one offer. Its economics are frozen from this point.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OfferAccepted {
    #[topic]
    pub milestone_id: u64,
    #[topic]
    pub offer_id: u64,
    pub funder: Address,
    pub principal: i128,
    pub repayment: i128,
}

/// Working capital moved **funder → supplier** from the funder's own capital.
///
/// `protected_amount` is emitted alongside so any indexer or auditor can see
/// that buyer escrow was untouched by this transfer: the advance is not drawn
/// from it, and the milestone's protected total is unchanged.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdvanceFunded {
    #[topic]
    pub milestone_id: u64,
    #[topic]
    pub offer_id: u64,
    pub funder: Address,
    pub supplier: Address,
    /// Transferred from funder capital to the supplier now.
    pub principal: i128,
    /// Owed to the funder first out of verified milestone escrow later.
    pub repayment: i128,
    /// Buyer escrow protecting this milestone, unchanged by this call.
    pub protected_amount: i128,
}

/// The supplier released an accepted offer that expired without the selected
/// funder ever advancing capital.
///
/// No value moves when this is emitted: buyer escrow is untouched and no funder
/// capital was ever committed. `request_reopened` distinguishes the two
/// recoveries — the finance request was still live and is usable again, or it
/// had expired too and the milestone returned to `Funded`.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptanceReleased {
    #[topic]
    pub milestone_id: u64,
    #[topic]
    pub offer_id: u64,
    pub supplier: Address,
    /// The funder that was selected but never funded.
    pub funder: Address,
    pub request_reopened: bool,
}

/// The supplier committed a SHA-256 digest of the off-chain evidence.
///
/// Only the digest is emitted. Raw documents and any KYC material stay
/// off-chain, and the contract attaches no meaning to what the digest covers —
/// production photos, a bill of lading or a delivery confirmation are all the
/// same 32 bytes here.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EvidenceSubmitted {
    #[topic]
    pub milestone_id: u64,
    pub supplier: Address,
    pub evidence_hash: BytesN<32>,
    /// True when this replaced an earlier, not-yet-verified submission.
    pub replaced_previous: bool,
}

/// The assigned attestor verified the milestone against a specific digest.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MilestoneVerified {
    #[topic]
    pub milestone_id: u64,
    pub attestor: Address,
    pub evidence_hash: BytesN<32>,
}

/// Protected escrow was paid out, funder first.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MilestoneSettled {
    #[topic]
    pub order_id: u64,
    #[topic]
    pub milestone_id: u64,
    /// Escrow released in total; equals `funder_repayment + supplier_payout`.
    pub protected_amount: i128,
    /// Repaid to the funder first. Zero when the milestone was unfinanced.
    pub funder_repayment: i128,
    /// The supplier's remainder after the funder was made whole.
    pub supplier_payout: i128,
}

/// Escrow was returned to the buyer after a REFUND resolution.
///
/// `funder_advance_outstanding` records that a funder's advance was **not**
/// reversed by this refund: the supplier keeps it, and the funder's claim is an
/// off-chain matter.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MilestoneRefunded {
    #[topic]
    pub order_id: u64,
    #[topic]
    pub milestone_id: u64,
    pub buyer: Address,
    pub refunded_amount: i128,
    pub funder_advance_outstanding: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputeOpened {
    #[topic]
    pub milestone_id: u64,
    #[topic]
    pub dispute_id: u64,
    pub opened_by: Address,
    pub resolver: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputeResolved {
    #[topic]
    pub milestone_id: u64,
    #[topic]
    pub dispute_id: u64,
    pub resolver: Address,
    /// True for SETTLE (milestone returns to verified), false for REFUND.
    pub settled: bool,
}

/// Every milestone on the order reached a terminal state.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OrderCompleted {
    #[topic]
    pub order_id: u64,
}

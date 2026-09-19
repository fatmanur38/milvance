#![no_std]
//! # MilvanceCore — domain and state machine (PKG-01)
//!
//! Milvance separates **payment protection** from **working-capital liquidity**:
//!
//! ```text
//! Buyer money  = protected milestone payment, locked in this contract.
//!                NOT the supplier's working capital.
//! Funder money = separate capital advanced funder → supplier, repaid first
//!                out of the verified milestone.
//! ```
//!
//! ## What this package implements
//!
//! The domain foundation and the legal state-transition surface: orders,
//! milestones, role assignment, transition guards, deterministic identifiers,
//! storage layout and events.
//!
//! ## What this package deliberately does NOT implement
//!
//! No token transfers, no escrow, no `fund_milestone`, no `fund_advance`, no
//! offers, no evidence, no attestation, no settlement, no disputes. Those arrive
//! in PKG-02 → PKG-04. The financing and dispute types in [`types`] are declared
//! so later packages extend this schema rather than redesign it.
//!
//! Consequently **no value can move through this contract yet**, and no code
//! path treats buyer money as supplier cash.

use soroban_sdk::{contract, contractimpl, Address, Env, Vec};

mod errors;
mod escrow;
mod events;
mod financing;
mod storage;
mod types;

pub use errors::Error;
pub use storage::{
    DataKey, MAX_MILESTONES_PER_ORDER, MAX_OFFERS_PER_MILESTONE, MAX_OFFER_VALIDITY_SECONDS,
    MAX_REQUEST_VALIDITY_SECONDS,
};
pub use types::{
    Config, Dispute, DisputeId, DisputeResolution, DisputeStatus, FinancePosition,
    FinancePositionStatus, FinanceRequest, FinanceRequestStatus, FundingOffer, Milestone,
    MilestoneId, MilestoneStatus, OfferId, OfferStatus, Order, OrderId, OrderStatus,
};

/// Protocol version of the contract surface. Bumped when the externally visible
/// surface changes, so off-chain bindings can detect drift.
pub const PROTOCOL_VERSION: u32 = 1;

#[contract]
pub struct MilvanceCore;

#[contractimpl]
impl MilvanceCore {
    /// Initializes protocol configuration at deploy time.
    ///
    /// Using a constructor rather than a callable `initialize` removes the
    /// possibility of an uninitialized window or a second initialization: the
    /// host runs this exactly once, atomically with deployment.
    ///
    /// `admin` is operational only and receives no financial authority anywhere
    /// in this contract (invariant 17).
    pub fn __constructor(env: &Env, admin: Address, usdc: Address) {
        let config = Config {
            admin,
            usdc,
            protocol_version: PROTOCOL_VERSION,
        };
        storage::write_config(env, &config);
        storage::extend_instance(env);
    }

    /// Protocol version of this contract build. Read-only, unauthenticated.
    pub fn protocol_version(_env: &Env) -> u32 {
        PROTOCOL_VERSION
    }

    // -----------------------------------------------------------------------
    // Order lifecycle
    // -----------------------------------------------------------------------

    /// Creates an order in `Created` and returns its id.
    ///
    /// Authorized by the **buyer**. The settlement asset is snapshotted from
    /// protocol config rather than accepted as a parameter, so an order can
    /// never be created against a non-USDC asset (invariant 20) and can never
    /// have its asset changed afterwards (invariant 19).
    ///
    /// Attestor and resolver must be third parties: allowing the buyer or
    /// supplier to attest their own milestone would defeat the verification
    /// model that settlement depends on. They must also differ from each other,
    /// so that a disputed verification is never reviewed by its own author.
    pub fn create_order(
        env: &Env,
        buyer: Address,
        supplier: Address,
        attestor: Address,
        resolver: Address,
    ) -> Result<u64, Error> {
        buyer.require_auth();

        let config = storage::read_config(env)?;

        if buyer == supplier {
            return Err(Error::InvalidParties);
        }
        if attestor == buyer || attestor == supplier {
            return Err(Error::InvalidAttestor);
        }
        if resolver == buyer || resolver == supplier {
            return Err(Error::InvalidResolver);
        }
        // Separation of duties: the party who verifies a milestone must not also
        // be the party who resolves a dispute about that verification.
        if attestor == resolver {
            return Err(Error::AttestorResolverConflict);
        }

        let order_id = storage::next_order_id(env);
        let order = Order {
            id: order_id,
            buyer: buyer.clone(),
            supplier: supplier.clone(),
            attestor: attestor.clone(),
            resolver: resolver.clone(),
            asset: config.usdc.clone(),
            status: OrderStatus::Created,
            created_at: env.ledger().timestamp(),
        };

        storage::write_order(env, &order);
        storage::extend_instance(env);
        events::OrderCreated {
            order_id,
            buyer,
            supplier,
            attestor,
            resolver,
            asset: config.usdc,
        }
        .publish(env);

        Ok(order_id)
    }

    /// Adds a milestone to an order and returns its id.
    ///
    /// Authorized by the **buyer**, and only while the order is still `Created`.
    /// Once the supplier accepts, the milestone set is frozen: the supplier
    /// commits to a known scope, and no party can enlarge the order afterwards.
    ///
    /// `amount` is the protected milestone payment the buyer will later escrow.
    /// Recording it does not move any value; escrow arrives in PKG-02.
    ///
    /// `deadline` is informational. Its expiry can never settle, refund, repay
    /// or penalize by itself (invariant 25) — it only lets the read model derive
    /// a `DELAYED` / `NEEDS_REVIEW` display status off-chain.
    pub fn create_milestone(
        env: &Env,
        order_id: u64,
        amount: i128,
        deadline: Option<u64>,
    ) -> Result<u64, Error> {
        let order = storage::read_order(env, order_id)?;
        order.buyer.require_auth();

        if order.status != OrderStatus::Created {
            return Err(Error::InvalidOrderStatus);
        }
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if let Some(deadline) = deadline {
            if deadline <= env.ledger().timestamp() {
                return Err(Error::InvalidDeadline);
            }
        }

        let mut milestone_ids = storage::read_order_milestones(env, order_id);
        if milestone_ids.len() >= MAX_MILESTONES_PER_ORDER {
            return Err(Error::MilestoneLimitReached);
        }

        let index = milestone_ids.len();
        let milestone_id = storage::next_milestone_id(env);
        let milestone = Milestone {
            id: milestone_id,
            order_id,
            index,
            amount,
            // Buyer escrow starts empty. Only PKG-02 may increase this, and only
            // from the buyer's own transfer into the contract.
            funded_amount: 0,
            deadline,
            status: MilestoneStatus::Unfunded,
            created_at: env.ledger().timestamp(),
        };

        milestone_ids.push_back(milestone_id);
        storage::write_milestone(env, &milestone);
        storage::write_order_milestones(env, order_id, &milestone_ids);
        storage::extend_instance(env);
        events::MilestoneCreated {
            order_id,
            milestone_id,
            index,
            amount,
            deadline,
        }
        .publish(env);

        Ok(milestone_id)
    }

    /// Supplier accepts the order, moving it `Created → Active`.
    ///
    /// Authorized by the **assigned supplier** only; the address is read from
    /// the stored order rather than taken as a parameter, so no other account
    /// can accept on their behalf.
    ///
    /// An order with no milestones cannot be accepted: there would be nothing to
    /// commit to.
    pub fn accept_order(env: &Env, order_id: u64) -> Result<(), Error> {
        let mut order = storage::read_order(env, order_id)?;
        order.supplier.require_auth();

        if order.status != OrderStatus::Created {
            return Err(Error::InvalidOrderStatus);
        }
        if storage::read_order_milestones(env, order_id).is_empty() {
            return Err(Error::OrderHasNoMilestones);
        }

        order.status = OrderStatus::Active;
        storage::write_order(env, &order);
        storage::extend_instance(env);
        events::OrderAccepted {
            order_id,
            supplier: order.supplier,
        }
        .publish(env);

        Ok(())
    }

    /// Buyer cancels an order that the supplier has not yet accepted.
    ///
    /// Restricted to `Created`, which is the only status in which no milestone
    /// can hold escrow. Cancelling an `Active` order would require unwinding
    /// escrow and any finance position, which is dispute/refund territory
    /// (PKG-04) and is deliberately not available here.
    pub fn cancel_order(env: &Env, order_id: u64) -> Result<(), Error> {
        let mut order = storage::read_order(env, order_id)?;
        order.buyer.require_auth();

        if order.status != OrderStatus::Created {
            return Err(Error::InvalidOrderStatus);
        }

        order.status = OrderStatus::Cancelled;
        storage::write_order(env, &order);
        storage::extend_instance(env);
        events::OrderCancelled {
            order_id,
            buyer: order.buyer,
        }
        .publish(env);

        Ok(())
    }

    // -----------------------------------------------------------------------
    // Milestone escrow
    // -----------------------------------------------------------------------

    /// Buyer deposits protected milestone payment into contract escrow.
    ///
    /// Returns the milestone's cumulative `funded_amount` after this deposit.
    ///
    /// **This is buyer protection, not supplier working capital.** The money
    /// moves buyer → contract and stays under contract control. Nothing in this
    /// package can pay it to the supplier, and the supplier's early liquidity
    /// comes from a funder's own capital in PKG-03, never from here.
    ///
    /// Authorized by the **buyer** of the milestone's order, read from stored
    /// state rather than a parameter.
    ///
    /// The order must be `Active`: money is only committed to a scope the
    /// supplier has accepted. This also keeps `cancel_order` (which is
    /// `Created`-only) permanently disjoint from any funded milestone.
    ///
    /// `asset` must equal the order's settlement asset. It is a required
    /// parameter so a client holding a stale or wrong asset id fails loudly
    /// instead of silently transferring the right one.
    ///
    /// Partial deposits are allowed and accumulate. The milestone only reaches
    /// `Funded` — and therefore only becomes financeable — once escrow equals
    /// the full protected amount (AGENT.md §9.5, invariant 23).
    pub fn fund_milestone(
        env: &Env,
        milestone_id: u64,
        amount: i128,
        asset: Address,
    ) -> Result<i128, Error> {
        let mut milestone = storage::read_milestone(env, milestone_id)?;
        let order = storage::read_order(env, milestone.order_id)?;

        order.buyer.require_auth();

        if order.status != OrderStatus::Active {
            return Err(Error::InvalidOrderStatus);
        }
        // Only an unfunded milestone accepts escrow. This rejects funding a
        // fully funded, financed, verified, settled or refunded milestone.
        if milestone.status != MilestoneStatus::Unfunded {
            return Err(Error::InvalidMilestoneStatus);
        }
        if asset != order.asset {
            return Err(Error::InvalidAsset);
        }

        escrow::deposit(env, &order, &mut milestone, amount)?;

        let fully_funded = escrow::is_fully_funded(&milestone);
        if fully_funded {
            milestone.status = MilestoneStatus::Funded;
        }

        storage::write_milestone(env, &milestone);
        storage::extend_instance(env);
        events::MilestoneFunded {
            order_id: milestone.order_id,
            milestone_id,
            buyer: order.buyer,
            amount,
            funded_amount: milestone.funded_amount,
            fully_funded,
        }
        .publish(env);

        Ok(milestone.funded_amount)
    }

    // -----------------------------------------------------------------------
    // Financing — request, offers, advance (PKG-03)
    // -----------------------------------------------------------------------

    /// Supplier requests working capital against a fully protected milestone.
    ///
    /// Authorized by the **supplier** of the milestone's order.
    ///
    /// Financeability (invariant 23): the milestone must hold its **full**
    /// protected amount. A partially funded milestone is not financeable,
    /// because the funder's underwriting input would be ambiguous.
    ///
    /// Requesting finance does not move any money and does not give the
    /// supplier access to buyer escrow. It opens the milestone to competing
    /// funder offers.
    ///
    /// A milestone whose previous request expired without being accepted may be
    /// re-requested, so an unanswered request cannot strand the milestone.
    pub fn request_finance(
        env: &Env,
        milestone_id: u64,
        requested_principal: i128,
        expires_at: u64,
    ) -> Result<(), Error> {
        let mut milestone = storage::read_milestone(env, milestone_id)?;
        let order = storage::read_order(env, milestone.order_id)?;

        order.supplier.require_auth();

        if order.status != OrderStatus::Active {
            return Err(Error::InvalidOrderStatus);
        }

        match milestone.status {
            MilestoneStatus::Funded => {}
            // Replacing a request is only allowed once the old one is dead.
            MilestoneStatus::FinanceRequested => {
                let existing = storage::read_finance_request(env, milestone_id)?;
                let still_live = existing.status == FinanceRequestStatus::Open
                    && financing::is_live(env, existing.expires_at);
                if still_live || existing.status == FinanceRequestStatus::Accepted {
                    return Err(Error::FinanceRequestActive);
                }
            }
            _ => return Err(Error::InvalidMilestoneStatus),
        }

        // Belt and braces: the status above should already imply this.
        if !escrow::is_fully_funded(&milestone) {
            return Err(Error::MilestoneNotFullyFunded);
        }
        if requested_principal <= 0 {
            return Err(Error::InvalidAmount);
        }
        // Repayment can never exceed protected escrow, and repayment >= principal,
        // so a principal above the protected amount could never be offered.
        if requested_principal > milestone.funded_amount {
            return Err(Error::RepaymentExceedsEscrow);
        }
        financing::validate_expiry(env, expires_at, MAX_REQUEST_VALIDITY_SECONDS)?;

        let request = FinanceRequest {
            milestone_id,
            supplier: order.supplier.clone(),
            requested_principal,
            status: FinanceRequestStatus::Open,
            expires_at,
            created_at: env.ledger().timestamp(),
        };

        milestone.status = MilestoneStatus::FinanceRequested;
        storage::write_finance_request(env, &request);
        storage::write_milestone(env, &milestone);
        // A re-request must not inherit the previous round's offer index.
        storage::write_milestone_offers(env, milestone_id, &Vec::new(env));
        storage::extend_instance(env);

        events::FinanceRequested {
            milestone_id,
            supplier: order.supplier,
            requested_principal,
            protected_amount: milestone.funded_amount,
            expires_at,
        }
        .publish(env);

        Ok(())
    }

    /// A funder prices an open finance request.
    ///
    /// Authorized by the **funder**, who must be independent of buyer,
    /// supplier, attestor and resolver.
    ///
    /// `principal` must equal the requested principal exactly, so competing
    /// offers differ only in `repayment` and the supplier's comparison is
    /// unambiguous. `repayment` must be at least `principal` and at most the
    /// protected milestone escrow (invariants 3, 4, 2).
    ///
    /// Making an offer commits no capital. The transfer happens in
    /// [`Self::fund_advance`], from the funder's own wallet.
    ///
    /// Offers live in temporary storage; their economics become permanent only
    /// when the supplier accepts.
    pub fn make_offer(
        env: &Env,
        milestone_id: u64,
        funder: Address,
        principal: i128,
        repayment: i128,
        expires_at: u64,
    ) -> Result<u64, Error> {
        funder.require_auth();

        let milestone = storage::read_milestone(env, milestone_id)?;
        let order = storage::read_order(env, milestone.order_id)?;
        let request = storage::read_finance_request(env, milestone_id)?;

        if order.status != OrderStatus::Active {
            return Err(Error::InvalidOrderStatus);
        }
        if milestone.status != MilestoneStatus::FinanceRequested {
            return Err(Error::InvalidMilestoneStatus);
        }
        if request.status != FinanceRequestStatus::Open {
            return Err(Error::InvalidFinanceRequestStatus);
        }
        if !financing::is_live(env, request.expires_at) {
            return Err(Error::FinanceRequestExpired);
        }
        financing::validate_funder(&order, &funder)?;
        if principal != request.requested_principal {
            return Err(Error::PrincipalMismatch);
        }
        financing::validate_economics(&milestone, principal, repayment)?;
        financing::validate_expiry(env, expires_at, MAX_OFFER_VALIDITY_SECONDS)?;

        let mut offer_ids = storage::read_milestone_offers(env, milestone_id);
        if offer_ids.len() >= MAX_OFFERS_PER_MILESTONE {
            return Err(Error::OfferLimitReached);
        }

        let offer_id = storage::next_offer_id(env);
        let offer = FundingOffer {
            id: offer_id,
            milestone_id,
            funder: funder.clone(),
            principal,
            repayment,
            expires_at,
            status: OfferStatus::Open,
        };

        offer_ids.push_back(offer_id);
        storage::write_offer(env, &offer);
        storage::write_milestone_offers(env, milestone_id, &offer_ids);
        storage::extend_instance(env);

        events::FundingOfferCreated {
            milestone_id,
            offer_id,
            funder,
            principal,
            repayment,
            expires_at,
        }
        .publish(env);

        Ok(offer_id)
    }

    /// A funder withdraws an offer that has not been accepted.
    ///
    /// Authorized by the **offer's own funder**. An accepted or funded offer
    /// cannot be cancelled: its economics are already locked.
    pub fn cancel_offer(env: &Env, offer_id: u64) -> Result<(), Error> {
        let mut offer = storage::read_offer(env, offer_id)?;

        offer.funder.require_auth();

        if offer.status != OfferStatus::Open {
            return Err(Error::InvalidOfferStatus);
        }

        offer.status = OfferStatus::Cancelled;
        storage::write_offer(env, &offer);
        storage::extend_instance(env);

        events::FundingOfferCancelled {
            milestone_id: offer.milestone_id,
            offer_id,
            funder: offer.funder,
        }
        .publish(env);

        Ok(())
    }

    /// Supplier selects exactly one offer.
    ///
    /// Authorized by the **supplier** of the milestone's order.
    ///
    /// The selected offer is copied into persistent storage here. That copy —
    /// not the temporary offer entry — is what [`Self::fund_advance`] reads, so
    /// the accepted economics survive the temporary entry's expiry and cannot
    /// be altered afterwards (invariant 7).
    ///
    /// Only one offer may be accepted per milestone: the request moves to
    /// `Accepted`, which rejects any further acceptance.
    pub fn accept_offer(env: &Env, offer_id: u64) -> Result<(), Error> {
        let mut offer = storage::read_offer(env, offer_id)?;
        let milestone = storage::read_milestone(env, offer.milestone_id)?;
        let order = storage::read_order(env, milestone.order_id)?;
        let mut request = storage::read_finance_request(env, offer.milestone_id)?;

        order.supplier.require_auth();

        if order.status != OrderStatus::Active {
            return Err(Error::InvalidOrderStatus);
        }
        if milestone.status != MilestoneStatus::FinanceRequested {
            return Err(Error::InvalidMilestoneStatus);
        }
        if request.status != FinanceRequestStatus::Open {
            return Err(Error::InvalidFinanceRequestStatus);
        }
        if !financing::is_live(env, request.expires_at) {
            return Err(Error::FinanceRequestExpired);
        }
        if offer.status != OfferStatus::Open {
            return Err(Error::InvalidOfferStatus);
        }
        if !financing::is_live(env, offer.expires_at) {
            return Err(Error::OfferExpired);
        }
        // An accepted offer already exists, or the milestone is already financed.
        if storage::find_accepted_offer(env, offer.milestone_id).is_some() {
            return Err(Error::FinanceRequestActive);
        }
        if storage::find_finance_position(env, offer.milestone_id).is_some() {
            return Err(Error::AlreadyFinanced);
        }
        // Re-check against live milestone state rather than trusting the offer.
        financing::validate_economics(&milestone, offer.principal, offer.repayment)?;

        offer.status = OfferStatus::Accepted;
        request.status = FinanceRequestStatus::Accepted;

        storage::write_offer(env, &offer);
        storage::write_finance_request(env, &request);
        storage::write_accepted_offer(env, offer.milestone_id, &offer);
        storage::extend_instance(env);

        events::OfferAccepted {
            milestone_id: offer.milestone_id,
            offer_id,
            funder: offer.funder,
            principal: offer.principal,
            repayment: offer.repayment,
        }
        .publish(env);

        Ok(())
    }

    /// The selected funder advances working capital to the supplier.
    ///
    /// **This moves the funder's own capital, funder wallet → supplier wallet.**
    /// Buyer milestone escrow is not the source, is not debited, and
    /// `funded_amount` is not written by this call. The buyer's protected
    /// amount is read only as the ceiling that repayment was validated against.
    ///
    /// Authorized by the **accepted offer's funder**, read from persistent
    /// state, so no other account can fund in their place.
    ///
    /// Atomic within one invocation: validate accepted offer → validate expiry
    /// → validate milestone state → validate no active position → require
    /// funder auth → transfer principal → persist `FinancePosition` →
    /// transition milestone → emit. Any failure reverts all of it, so an
    /// `Active` position can never exist without its transfer having happened.
    pub fn fund_advance(env: &Env, milestone_id: u64) -> Result<(), Error> {
        let mut milestone = storage::read_milestone(env, milestone_id)?;
        let order = storage::read_order(env, milestone.order_id)?;
        let mut accepted = storage::read_accepted_offer(env, milestone_id)?;

        // Invariant 1 is checked first, and deliberately so: it is the
        // strongest guard in this function, and checking it before the weaker
        // status guards means a duplicate-financing attempt always reports
        // `AlreadyFinanced` rather than being masked by a downstream status
        // mismatch. The losing side of a funder race lands here.
        if storage::find_finance_position(env, milestone_id).is_some() {
            return Err(Error::AlreadyFinanced);
        }
        if accepted.status != OfferStatus::Accepted {
            return Err(Error::InvalidOfferStatus);
        }
        if !financing::is_live(env, accepted.expires_at) {
            return Err(Error::OfferExpired);
        }
        if order.status != OrderStatus::Active {
            return Err(Error::InvalidOrderStatus);
        }
        // Redundant with the position check above, and kept as a second
        // independent barrier: a financed milestone has already left
        // FinanceRequested.
        if milestone.status != MilestoneStatus::FinanceRequested {
            return Err(Error::InvalidMilestoneStatus);
        }

        accepted.funder.require_auth();

        financing::validate_funder(&order, &accepted.funder)?;
        financing::validate_economics(&milestone, accepted.principal, accepted.repayment)?;

        let escrow_before = milestone.funded_amount;

        // Funder capital → supplier. No contract escrow is involved.
        financing::transfer_advance(env, &order, &accepted)?;

        let position = FinancePosition {
            milestone_id,
            offer_id: accepted.id,
            funder: accepted.funder.clone(),
            supplier: order.supplier.clone(),
            principal: accepted.principal,
            repayment: accepted.repayment,
            status: FinancePositionStatus::Active,
            funded_at: env.ledger().timestamp(),
        };

        accepted.status = OfferStatus::Funded;
        milestone.status = MilestoneStatus::Financed;

        // Defensive barrier for the invariant this whole package rests on:
        // the advance came from funder capital, so protected buyer escrow must
        // be bit-for-bit unchanged. `funded_amount` is written only by the
        // escrow module, which this path never calls, so this should be
        // unreachable — and if it is ever reached, the transfer above is
        // reverted along with everything else.
        if milestone.funded_amount != escrow_before {
            return Err(Error::EscrowMutated);
        }

        storage::write_finance_position(env, &position);
        storage::write_accepted_offer(env, milestone_id, &accepted);
        storage::write_milestone(env, &milestone);
        storage::extend_instance(env);

        events::AdvanceFunded {
            milestone_id,
            offer_id: accepted.id,
            funder: accepted.funder,
            supplier: order.supplier,
            principal: accepted.principal,
            repayment: accepted.repayment,
            protected_amount: milestone.funded_amount,
        }
        .publish(env);

        Ok(())
    }

    /// Supplier releases an accepted offer that expired without being funded.
    ///
    /// Authorized by the **supplier** of the milestone's order.
    ///
    /// A selected funder is not obliged to advance. Without this, a funder that
    /// simply walked away would strand the supplier behind a spent request
    /// until the request itself expired — a liveness gap, not a safety one.
    ///
    /// Allowed only when all of the following hold, so it can never be used to
    /// unwind real financing:
    /// - an accepted offer exists,
    /// - it has passed its expiry,
    /// - it was never funded,
    /// - no `FinancePosition` exists for the milestone.
    ///
    /// Recovery takes one of two shapes, and adds **no new milestone state**:
    ///
    /// - the finance request is still live → it reopens to `Open`, the
    ///   milestone stays `FinanceRequested`, and the supplier may select
    ///   another offer or receive new ones;
    /// - the finance request has also expired → it closes, and the milestone
    ///   returns to `Funded` so the supplier can call `request_finance` again.
    ///
    /// **Moves no value.** Buyer escrow is untouched and no funder capital was
    /// ever committed — an accepted offer is a selection, not a transfer.
    ///
    /// Returns `true` if the request was reopened, `false` if the milestone
    /// returned to `Funded`.
    pub fn release_expired_acceptance(env: &Env, milestone_id: u64) -> Result<bool, Error> {
        let mut milestone = storage::read_milestone(env, milestone_id)?;
        let order = storage::read_order(env, milestone.order_id)?;

        order.supplier.require_auth();

        // Checked first, as in `fund_advance`: a milestone that carries a
        // position has real financing and must never be unwound here.
        if storage::find_finance_position(env, milestone_id).is_some() {
            return Err(Error::AlreadyFinanced);
        }

        let accepted = storage::read_accepted_offer(env, milestone_id)?;

        // A funded acceptance means capital already moved to the supplier.
        if accepted.status != OfferStatus::Accepted {
            return Err(Error::InvalidOfferStatus);
        }
        // Only an expired acceptance may be released; a live one still belongs
        // to the selected funder.
        if financing::is_live(env, accepted.expires_at) {
            return Err(Error::OfferStillLive);
        }
        if order.status != OrderStatus::Active {
            return Err(Error::InvalidOrderStatus);
        }
        if milestone.status != MilestoneStatus::FinanceRequested {
            return Err(Error::InvalidMilestoneStatus);
        }

        let mut request = storage::read_finance_request(env, milestone_id)?;
        let request_reopened = financing::is_live(env, request.expires_at);

        // Clearing this is what stops the lapsed funder calling `fund_advance`:
        // that function reads the accepted offer and errors without one.
        storage::remove_accepted_offer(env, milestone_id);

        // Retire the temporary offer entry too, if it still exists, so the
        // lapsed selection cannot reappear as selectable.
        if let Some(mut offer) = storage::find_offer(env, accepted.id) {
            offer.status = OfferStatus::Cancelled;
            storage::write_offer(env, &offer);
        }

        if request_reopened {
            // The request still has time left: make it usable again.
            request.status = FinanceRequestStatus::Open;
        } else {
            // The request lapsed as well: close it and hand the milestone back
            // to its protected, financeable state.
            request.status = FinanceRequestStatus::Cancelled;
            milestone.status = MilestoneStatus::Funded;
            storage::write_milestone(env, &milestone);
        }

        storage::write_finance_request(env, &request);
        storage::extend_instance(env);

        events::AcceptanceReleased {
            milestone_id,
            offer_id: accepted.id,
            supplier: order.supplier,
            funder: accepted.funder,
            request_reopened,
        }
        .publish(env);

        Ok(request_reopened)
    }

    // -----------------------------------------------------------------------
    // Read helpers
    // -----------------------------------------------------------------------

    /// Whether the milestone holds its full protected amount.
    ///
    /// The MVP financeability precondition. PKG-03 adds the remaining
    /// conditions before a finance request may be opened.
    pub fn is_fully_funded(env: &Env, milestone_id: u64) -> Result<bool, Error> {
        Ok(escrow::is_fully_funded(&storage::read_milestone(
            env,
            milestone_id,
        )?))
    }

    pub fn get_config(env: &Env) -> Result<Config, Error> {
        storage::read_config(env)
    }

    pub fn get_order(env: &Env, order_id: u64) -> Result<Order, Error> {
        storage::read_order(env, order_id)
    }

    pub fn get_milestone(env: &Env, milestone_id: u64) -> Result<Milestone, Error> {
        storage::read_milestone(env, milestone_id)
    }

    /// Milestone ids of an existing order, in creation order.
    pub fn get_order_milestones(env: &Env, order_id: u64) -> Result<Vec<u64>, Error> {
        storage::read_order(env, order_id)?;
        Ok(storage::read_order_milestones(env, order_id))
    }

    pub fn get_finance_request(env: &Env, milestone_id: u64) -> Result<FinanceRequest, Error> {
        storage::read_finance_request(env, milestone_id)
    }

    /// A single offer by id. Errors if its temporary entry is gone.
    pub fn get_offer(env: &Env, offer_id: u64) -> Result<FundingOffer, Error> {
        storage::read_offer(env, offer_id)
    }

    /// Raw offer-id index for a milestone.
    ///
    /// The index is temporary and may name offers whose entry has already
    /// expired. Prefer [`Self::get_open_offers`], which resolves the ids and
    /// drops anything stale.
    pub fn get_milestone_offer_ids(env: &Env, milestone_id: u64) -> Vec<u64> {
        storage::read_milestone_offers(env, milestone_id)
    }

    /// Offers on a milestone that are still open and still live.
    ///
    /// Resolves each indexed id and skips entries that are missing, cancelled,
    /// accepted, funded or past their expiry, so a stale index can never
    /// present a dead offer as selectable.
    pub fn get_open_offers(env: &Env, milestone_id: u64) -> Vec<FundingOffer> {
        let mut open = Vec::new(env);
        for offer_id in storage::read_milestone_offers(env, milestone_id).iter() {
            if let Some(offer) = storage::find_offer(env, offer_id) {
                if offer.status == OfferStatus::Open && financing::is_live(env, offer.expires_at) {
                    open.push_back(offer);
                }
            }
        }
        open
    }

    /// The offer the supplier selected, held in persistent storage.
    pub fn get_accepted_offer(env: &Env, milestone_id: u64) -> Result<FundingOffer, Error> {
        storage::read_accepted_offer(env, milestone_id)
    }

    pub fn get_finance_position(env: &Env, milestone_id: u64) -> Result<FinancePosition, Error> {
        storage::read_finance_position(env, milestone_id)
    }

    /// Whether this milestone already carries an ACTIVE finance position.
    pub fn has_active_finance_position(env: &Env, milestone_id: u64) -> bool {
        match storage::find_finance_position(env, milestone_id) {
            Some(position) => position.status == FinancePositionStatus::Active,
            None => false,
        }
    }

    /// Number of orders created so far; also the id of the most recent order.
    pub fn order_count(env: &Env) -> u64 {
        storage::order_count(env)
    }

    /// Number of funding offers created so far, across all milestones.
    pub fn offer_count(env: &Env) -> u64 {
        storage::offer_count(env)
    }

    /// Number of milestones created so far, across all orders.
    pub fn milestone_count(env: &Env) -> u64 {
        storage::milestone_count(env)
    }
}

#[cfg(test)]
mod test;

use soroban_sdk::{contracttype, Env, Vec};

use crate::errors::Error;
use crate::types::{
    Config, FinancePosition, FinanceRequest, FundingOffer, Milestone, MilestoneId, OfferId, Order,
    OrderId,
};

/// Approximate ledgers per day at a ~5 second close time.
pub const DAY_IN_LEDGERS: u32 = 17_280;

/// Instance storage holds config and counters: small, read on nearly every call.
pub const INSTANCE_LIFETIME_THRESHOLD: u32 = 7 * DAY_IN_LEDGERS;
pub const INSTANCE_BUMP_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;

/// Persistent storage holds long-lived financial records. These must outlive a
/// long shipment window, so they are extended aggressively on every touch.
pub const PERSISTENT_LIFETIME_THRESHOLD: u32 = 14 * DAY_IN_LEDGERS;
pub const PERSISTENT_BUMP_AMOUNT: u32 = 60 * DAY_IN_LEDGERS;

/// Temporary storage holds open funding offers only.
///
/// The bump deliberately exceeds [`MAX_OFFER_VALIDITY_SECONDS`] so that an
/// offer's *storage* always outlives its *business* expiry. An offer therefore
/// expires because its `expires_at` timestamp passed — a checkable, explainable
/// rejection — rather than by silently vanishing from storage.
pub const TEMPORARY_LIFETIME_THRESHOLD: u32 = 2 * DAY_IN_LEDGERS;
pub const TEMPORARY_BUMP_AMOUNT: u32 = 10 * DAY_IN_LEDGERS;

/// Longest validity window a funding offer may declare (7 days).
pub const MAX_OFFER_VALIDITY_SECONDS: u64 = 7 * 24 * 60 * 60;

/// Longest validity window a finance request may declare (30 days).
pub const MAX_REQUEST_VALIDITY_SECONDS: u64 = 30 * 24 * 60 * 60;

/// Upper bound on offers indexed per milestone, so the offer index stays a
/// bounded read.
pub const MAX_OFFERS_PER_MILESTONE: u32 = 10;

/// Upper bound on milestones per order, so `OrderMilestones` stays a bounded
/// read and an order can never be made unreadable by unbounded growth.
pub const MAX_MILESTONES_PER_ORDER: u32 = 20;

/// Storage keys.
///
/// Keys for financing and disputes are declared now so PKG-03/PKG-04 extend the
/// schema instead of redesigning it. Placement follows AGENT.md §18:
///
/// - **Instance:** `Config`, counters
/// - **Persistent:** `Order`, `OrderMilestones`, `Milestone`, `FinanceRequest`,
///   `FinancePosition`, `Dispute`, `MilestoneDispute`
/// - **Temporary:** `Offer`, `MilestoneOffers` (open offers only)
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    // --- instance ---
    Config,
    OrderCounter,
    MilestoneCounter,
    OfferCounter,
    DisputeCounter,

    // --- persistent ---
    Order(u64),
    OrderMilestones(u64),
    Milestone(u64),
    FinanceRequest(u64),
    /// Snapshot of the offer the supplier selected, keyed by milestone.
    ///
    /// Persistent on purpose: the open offer it was copied from lives in
    /// temporary storage, and accepted economics must survive that entry's
    /// expiry unchanged.
    AcceptedOffer(u64),
    FinancePosition(u64),
    Dispute(u64),
    MilestoneDispute(u64),

    // --- temporary ---
    Offer(u64),
    MilestoneOffers(u64),
}

// ---------------------------------------------------------------------------
// Instance storage
// ---------------------------------------------------------------------------

pub fn extend_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

pub fn write_config(env: &Env, config: &Config) {
    env.storage().instance().set(&DataKey::Config, config);
}

pub fn read_config(env: &Env) -> Result<Config, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .ok_or(Error::NotInitialized)
}

/// Returns the next id for `key` and persists the incremented counter.
///
/// Counters start at 1. Ids are allocated strictly in sequence within a single
/// contract invocation, so two calls can never receive the same id.
fn next_id(env: &Env, key: &DataKey) -> u64 {
    let current: u64 = env.storage().instance().get(key).unwrap_or(0);
    let next = current + 1;
    env.storage().instance().set(key, &next);
    next
}

pub fn next_order_id(env: &Env) -> OrderId {
    next_id(env, &DataKey::OrderCounter)
}

pub fn next_milestone_id(env: &Env) -> MilestoneId {
    next_id(env, &DataKey::MilestoneCounter)
}

/// Current counter values, for read helpers and tests.
pub fn order_count(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::OrderCounter)
        .unwrap_or(0)
}

pub fn milestone_count(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::MilestoneCounter)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Persistent storage
// ---------------------------------------------------------------------------

fn extend_persistent(env: &Env, key: &DataKey) {
    env.storage().persistent().extend_ttl(
        key,
        PERSISTENT_LIFETIME_THRESHOLD,
        PERSISTENT_BUMP_AMOUNT,
    );
}

pub fn write_order(env: &Env, order: &Order) {
    let key = DataKey::Order(order.id);
    env.storage().persistent().set(&key, order);
    extend_persistent(env, &key);
}

pub fn read_order(env: &Env, order_id: OrderId) -> Result<Order, Error> {
    let key = DataKey::Order(order_id);
    let order: Order = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::OrderNotFound)?;
    extend_persistent(env, &key);
    Ok(order)
}

pub fn write_milestone(env: &Env, milestone: &Milestone) {
    let key = DataKey::Milestone(milestone.id);
    env.storage().persistent().set(&key, milestone);
    extend_persistent(env, &key);
}

pub fn read_milestone(env: &Env, milestone_id: MilestoneId) -> Result<Milestone, Error> {
    let key = DataKey::Milestone(milestone_id);
    let milestone: Milestone = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::MilestoneNotFound)?;
    extend_persistent(env, &key);
    Ok(milestone)
}

pub fn write_order_milestones(env: &Env, order_id: OrderId, milestones: &Vec<MilestoneId>) {
    let key = DataKey::OrderMilestones(order_id);
    env.storage().persistent().set(&key, milestones);
    extend_persistent(env, &key);
}

/// Milestone ids belonging to an order, in creation order.
///
/// Returns an empty vector for an order that exists but has no milestones yet;
/// callers that need existence checks must read the order itself.
pub fn read_order_milestones(env: &Env, order_id: OrderId) -> Vec<MilestoneId> {
    let key = DataKey::OrderMilestones(order_id);
    match env.storage().persistent().get(&key) {
        Some(milestones) => {
            extend_persistent(env, &key);
            milestones
        }
        None => Vec::new(env),
    }
}

// ---------------------------------------------------------------------------
// Financing — persistent records (PKG-03)
// ---------------------------------------------------------------------------

pub fn next_offer_id(env: &Env) -> OfferId {
    next_id(env, &DataKey::OfferCounter)
}

pub fn offer_count(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::OfferCounter)
        .unwrap_or(0)
}

pub fn write_finance_request(env: &Env, request: &FinanceRequest) {
    let key = DataKey::FinanceRequest(request.milestone_id);
    env.storage().persistent().set(&key, request);
    extend_persistent(env, &key);
}

pub fn find_finance_request(env: &Env, milestone_id: MilestoneId) -> Option<FinanceRequest> {
    let key = DataKey::FinanceRequest(milestone_id);
    let request: Option<FinanceRequest> = env.storage().persistent().get(&key);
    if request.is_some() {
        extend_persistent(env, &key);
    }
    request
}

pub fn read_finance_request(env: &Env, milestone_id: MilestoneId) -> Result<FinanceRequest, Error> {
    find_finance_request(env, milestone_id).ok_or(Error::FinanceRequestNotFound)
}

pub fn write_accepted_offer(env: &Env, milestone_id: MilestoneId, offer: &FundingOffer) {
    let key = DataKey::AcceptedOffer(milestone_id);
    env.storage().persistent().set(&key, offer);
    extend_persistent(env, &key);
}

pub fn find_accepted_offer(env: &Env, milestone_id: MilestoneId) -> Option<FundingOffer> {
    let key = DataKey::AcceptedOffer(milestone_id);
    let offer: Option<FundingOffer> = env.storage().persistent().get(&key);
    if offer.is_some() {
        extend_persistent(env, &key);
    }
    offer
}

pub fn read_accepted_offer(env: &Env, milestone_id: MilestoneId) -> Result<FundingOffer, Error> {
    find_accepted_offer(env, milestone_id).ok_or(Error::NoAcceptedOffer)
}

/// Clears a milestone's accepted-offer record.
///
/// Only used by the liveness recovery path, and only once the acceptance has
/// expired with no advance having moved.
pub fn remove_accepted_offer(env: &Env, milestone_id: MilestoneId) {
    env.storage()
        .persistent()
        .remove(&DataKey::AcceptedOffer(milestone_id));
}

pub fn write_finance_position(env: &Env, position: &FinancePosition) {
    let key = DataKey::FinancePosition(position.milestone_id);
    env.storage().persistent().set(&key, position);
    extend_persistent(env, &key);
}

pub fn find_finance_position(env: &Env, milestone_id: MilestoneId) -> Option<FinancePosition> {
    let key = DataKey::FinancePosition(milestone_id);
    let position: Option<FinancePosition> = env.storage().persistent().get(&key);
    if position.is_some() {
        extend_persistent(env, &key);
    }
    position
}

pub fn read_finance_position(
    env: &Env,
    milestone_id: MilestoneId,
) -> Result<FinancePosition, Error> {
    find_finance_position(env, milestone_id).ok_or(Error::FinancePositionNotFound)
}

// ---------------------------------------------------------------------------
// Financing — temporary records (PKG-03)
// ---------------------------------------------------------------------------

fn extend_temporary(env: &Env, key: &DataKey) {
    env.storage()
        .temporary()
        .extend_ttl(key, TEMPORARY_LIFETIME_THRESHOLD, TEMPORARY_BUMP_AMOUNT);
}

pub fn write_offer(env: &Env, offer: &FundingOffer) {
    let key = DataKey::Offer(offer.id);
    env.storage().temporary().set(&key, offer);
    extend_temporary(env, &key);
}

pub fn find_offer(env: &Env, offer_id: OfferId) -> Option<FundingOffer> {
    let key = DataKey::Offer(offer_id);
    let offer: Option<FundingOffer> = env.storage().temporary().get(&key);
    if offer.is_some() {
        extend_temporary(env, &key);
    }
    offer
}

pub fn read_offer(env: &Env, offer_id: OfferId) -> Result<FundingOffer, Error> {
    find_offer(env, offer_id).ok_or(Error::OfferNotFound)
}

pub fn write_milestone_offers(env: &Env, milestone_id: MilestoneId, offers: &Vec<OfferId>) {
    let key = DataKey::MilestoneOffers(milestone_id);
    env.storage().temporary().set(&key, offers);
    extend_temporary(env, &key);
}

/// Offer ids indexed for a milestone.
///
/// This index is a **UI convenience only**. It lives in temporary storage and
/// may contain ids whose offer entry has already expired, so no financial
/// decision may be made from it: every guard reads the offer entry directly by
/// id, and a missing entry is `OfferNotFound`.
pub fn read_milestone_offers(env: &Env, milestone_id: MilestoneId) -> Vec<OfferId> {
    let key = DataKey::MilestoneOffers(milestone_id);
    match env.storage().temporary().get(&key) {
        Some(offers) => {
            extend_temporary(env, &key);
            offers
        }
        None => Vec::new(env),
    }
}

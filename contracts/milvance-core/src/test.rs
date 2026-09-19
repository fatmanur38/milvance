#![cfg(test)]
extern crate std;

use soroban_sdk::{
    testutils::{
        storage::{Instance as _, Persistent as _, Temporary as _},
        Address as _, Events, Ledger, MockAuth, MockAuthInvoke,
    },
    token::{Client as TokenClient, StellarAssetClient},
    xdr::ContractEventBody,
    Address, BytesN, Env, IntoVal, Symbol, TryFromVal, Val,
};

use crate::storage::{INSTANCE_BUMP_AMOUNT, PERSISTENT_BUMP_AMOUNT, TEMPORARY_BUMP_AMOUNT};
use crate::{
    DataKey, DisputeResolution, DisputeStatus, Error, FinancePositionStatus, FinanceRequestStatus,
    MilestoneStatus, MilvanceCore, MilvanceCoreClient, OfferStatus, OrderStatus,
    MAX_MILESTONES_PER_ORDER, MAX_OFFERS_PER_MILESTONE, MAX_OFFER_VALIDITY_SECONDS,
    MAX_REQUEST_VALIDITY_SECONDS, PROTOCOL_VERSION,
};

/// Stellar assets carry 7 decimals, so amounts are expressed in stroops.
const STROOPS_PER_UNIT: i128 = 10_000_000;

/// Mirrors the canonical example in AGENT.md §9: M1 = 2,000 USDC, M2 = 3,000 USDC.
const AMOUNT_M1: i128 = 2_000 * STROOPS_PER_UNIT;
const AMOUNT_M2: i128 = 3_000 * STROOPS_PER_UNIT;

/// Enough for the buyer to fully protect both milestones with room to spare.
const BUYER_INITIAL_BALANCE: i128 = 10_000 * STROOPS_PER_UNIT;

/// Each funder's own capital, held in their own wallet.
const FUNDER_INITIAL_BALANCE: i128 = 5_000 * STROOPS_PER_UNIT;

/// Stellar's network-wide maximum entry TTL, so TTL assertions reflect the
/// limits the contract will actually meet on testnet.
const MAX_ENTRY_TTL: u32 = 6_312_000;

/// A little under our 60-day persistent bump: a realistic sea-freight window
/// during which a funded milestone must not be allowed to expire.
const LONG_SHIPMENT_LEDGERS: u32 = 50 * 17_280;

/// Canonical financing example from AGENT.md §9.2/§9.3: the supplier requests
/// 1,400 against a 2,000 protected milestone, and funders compete on repayment.
const PRINCIPAL: i128 = 1_400 * STROOPS_PER_UNIT;
const REPAYMENT_A: i128 = 1_470 * STROOPS_PER_UNIT;
const REPAYMENT_B: i128 = 1_445 * STROOPS_PER_UNIT;

const REQUEST_TTL: u64 = 14 * 24 * 60 * 60;
const OFFER_TTL: u64 = 3 * 24 * 60 * 60;

struct Fixture {
    env: Env,
    contract_id: Address,
    client: MilvanceCoreClient<'static>,
    /// The configured settlement asset (a real SAC, not a stub address).
    usdc: Address,
    /// A different SAC, used to prove non-approved assets are rejected.
    other_asset: Address,
    buyer: Address,
    supplier: Address,
    attestor: Address,
    resolver: Address,
    outsider: Address,
    /// Two competing funders, each holding their own capital.
    funder_a: Address,
    funder_b: Address,
}

impl Fixture {
    /// Creates an order with one milestone, leaving it in `Created`.
    fn order_with_milestone(&self) -> u64 {
        let order_id =
            self.client
                .create_order(&self.buyer, &self.supplier, &self.attestor, &self.resolver);
        self.client.create_milestone(&order_id, &AMOUNT_M1, &None);
        order_id
    }

    /// Creates an order with one milestone and has the supplier accept it.
    fn active_order(&self) -> u64 {
        let order_id = self.order_with_milestone();
        self.client.accept_order(&order_id);
        order_id
    }

    /// First topic of the most recently published event, as a Symbol.
    ///
    /// `#[contractevent]` puts the event name in topic 0, which is what the
    /// PKG-08 indexer will filter on.
    ///
    /// Note: the test event buffer is scoped to the most recent contract
    /// invocation, so `event_count` is "events emitted by the last call", not
    /// a running total.
    fn last_event_name(&self) -> Symbol {
        let all = self.env.events().all();
        let events = all.events();
        let last = events.last().expect("no events published");
        let ContractEventBody::V0(body) = &last.body;
        let topic = body.topics.first().expect("event has no topics");
        let topic: Val = Val::try_from_val(&self.env, topic).expect("topic is not a Val");
        Symbol::try_from_val(&self.env, &topic).expect("first topic is not a Symbol")
    }

    fn event_count(&self) -> usize {
        self.env.events().all().events().len()
    }

    // --- PKG-02 helpers ---

    fn balance(&self, who: &Address) -> i128 {
        TokenClient::new(&self.env, &self.usdc).balance(who)
    }

    /// Total settlement asset held by the contract, i.e. all milestone escrow.
    fn escrow_balance(&self) -> i128 {
        self.balance(&self.contract_id)
    }

    /// An `Active` order with two milestones (2,000 and 3,000 USDC).
    fn active_order_with_two_milestones(&self) -> (u64, u64, u64) {
        let order_id =
            self.client
                .create_order(&self.buyer, &self.supplier, &self.attestor, &self.resolver);
        let m1 = self.client.create_milestone(&order_id, &AMOUNT_M1, &None);
        let m2 = self.client.create_milestone(&order_id, &AMOUNT_M2, &None);
        self.client.accept_order(&order_id);
        (order_id, m1, m2)
    }

    fn milestone_ttl(&self, milestone_id: u64) -> u32 {
        self.env.as_contract(&self.contract_id, || {
            self.env
                .storage()
                .persistent()
                .get_ttl(&DataKey::Milestone(milestone_id))
        })
    }

    // --- PKG-03 helpers ---

    fn now(&self) -> u64 {
        self.env.ledger().timestamp()
    }

    fn advance_time(&self, seconds: u64) {
        self.env
            .ledger()
            .with_mut(|ledger| ledger.timestamp += seconds);
    }

    /// An active order whose M1 is fully protected and has an open finance
    /// request. Returns `(order_id, m1, m2)`.
    fn milestone_seeking_finance(&self) -> (u64, u64, u64) {
        let (order_id, m1, m2) = self.active_order_with_two_milestones();
        self.client.fund_milestone(&m1, &AMOUNT_M1, &self.usdc);
        self.client
            .request_finance(&m1, &PRINCIPAL, &(self.now() + REQUEST_TTL));
        (order_id, m1, m2)
    }

    /// Two competing offers on M1: A at 1,470 repayment, B at the better 1,445.
    fn competing_offers(&self, milestone_id: u64) -> (u64, u64) {
        let expires = self.now() + OFFER_TTL;
        let offer_a = self.client.make_offer(
            &milestone_id,
            &self.funder_a,
            &PRINCIPAL,
            &REPAYMENT_A,
            &expires,
        );
        let offer_b = self.client.make_offer(
            &milestone_id,
            &self.funder_b,
            &PRINCIPAL,
            &REPAYMENT_B,
            &expires,
        );
        (offer_a, offer_b)
    }

    // --- PKG-04 helpers ---

    /// A distinct, non-zero 32-byte digest.
    fn evidence(&self, seed: u8) -> BytesN<32> {
        let mut bytes = [0u8; 32];
        bytes[0] = seed;
        bytes[31] = seed.wrapping_add(7);
        BytesN::from_array(&self.env, &bytes)
    }

    /// Drives a financed milestone all the way to `Verified`.
    fn financed_and_verified(&self) -> (u64, u64, u64) {
        let (order_id, m1, m2) = self.milestone_seeking_finance();
        let (_, offer_b) = self.competing_offers(m1);
        self.client.accept_offer(&offer_b);
        self.client.fund_advance(&m1);
        let hash = self.evidence(1);
        self.client.submit_evidence(&m1, &hash);
        self.client.attest_milestone(&m1, &hash);
        (order_id, m1, m2)
    }

    /// Drives an unfinanced milestone to `Verified`.
    fn unfinanced_and_verified(&self) -> (u64, u64, u64) {
        let (order_id, m1, m2) = self.active_order_with_two_milestones();
        self.client.fund_milestone(&m1, &AMOUNT_M1, &self.usdc);
        let hash = self.evidence(2);
        self.client.submit_evidence(&m1, &hash);
        self.client.attest_milestone(&m1, &hash);
        (order_id, m1, m2)
    }

    fn offer_ttl(&self, offer_id: u64) -> u32 {
        self.env.as_contract(&self.contract_id, || {
            self.env
                .storage()
                .temporary()
                .get_ttl(&DataKey::Offer(offer_id))
        })
    }

    fn instance_ttl(&self) -> u32 {
        self.env.as_contract(&self.contract_id, || {
            self.env.storage().instance().get_ttl()
        })
    }
}

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_max_entry_ttl(MAX_ENTRY_TTL);

    let admin = Address::generate(&env);
    let issuer = Address::generate(&env);

    let usdc = env
        .register_stellar_asset_contract_v2(issuer.clone())
        .address();
    let other_asset = env.register_stellar_asset_contract_v2(issuer).address();

    let contract_id = env.register(MilvanceCore, (&admin, &usdc));
    let client = MilvanceCoreClient::new(&env, &contract_id);

    let buyer = Address::generate(&env);
    let funder_a = Address::generate(&env);
    let funder_b = Address::generate(&env);

    let usdc_admin = StellarAssetClient::new(&env, &usdc);
    usdc_admin.mint(&buyer, &BUYER_INITIAL_BALANCE);
    // Funder capital is entirely separate from buyer money.
    usdc_admin.mint(&funder_a, &FUNDER_INITIAL_BALANCE);
    usdc_admin.mint(&funder_b, &FUNDER_INITIAL_BALANCE);
    StellarAssetClient::new(&env, &other_asset).mint(&buyer, &BUYER_INITIAL_BALANCE);

    Fixture {
        contract_id,
        client,
        usdc,
        other_asset,
        buyer,
        supplier: Address::generate(&env),
        attestor: Address::generate(&env),
        resolver: Address::generate(&env),
        outsider: Address::generate(&env),
        funder_a,
        funder_b,
        env,
    }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

#[test]
fn constructor_stores_config() {
    let f = setup();
    let config = f.client.get_config();

    assert_eq!(config.usdc, f.usdc);
    assert_eq!(config.protocol_version, PROTOCOL_VERSION);
    assert_eq!(f.client.protocol_version(), PROTOCOL_VERSION);
}

// ---------------------------------------------------------------------------
// create_order
// ---------------------------------------------------------------------------

#[test]
fn create_order_sets_initial_state_and_actors() {
    let f = setup();
    let order_id = f
        .client
        .create_order(&f.buyer, &f.supplier, &f.attestor, &f.resolver);

    let order = f.client.get_order(&order_id);

    assert_eq!(order.id, order_id);
    assert_eq!(order.status, OrderStatus::Created);
    assert_eq!(order.buyer, f.buyer);
    assert_eq!(order.supplier, f.supplier);
    assert_eq!(order.attestor, f.attestor);
    assert_eq!(order.resolver, f.resolver);
    // An order can only ever settle in the configured asset (invariants 19, 20).
    assert_eq!(order.asset, f.usdc);
    assert!(f.client.get_order_milestones(&order_id).is_empty());
}

#[test]
fn order_ids_increment_deterministically_from_one() {
    let f = setup();

    let first = f
        .client
        .create_order(&f.buyer, &f.supplier, &f.attestor, &f.resolver);
    let second = f
        .client
        .create_order(&f.buyer, &f.supplier, &f.attestor, &f.resolver);
    let third = f
        .client
        .create_order(&f.buyer, &f.supplier, &f.attestor, &f.resolver);

    assert_eq!((first, second, third), (1, 2, 3));
    assert_eq!(f.client.order_count(), 3);
}

#[test]
fn create_order_rejects_buyer_as_supplier() {
    let f = setup();
    let result = f
        .client
        .try_create_order(&f.buyer, &f.buyer, &f.attestor, &f.resolver);

    assert_eq!(result, Err(Ok(Error::InvalidParties)));
}

#[test]
fn create_order_rejects_attestor_who_is_a_counterparty() {
    let f = setup();

    // A buyer who can attest their own milestone defeats verification.
    assert_eq!(
        f.client
            .try_create_order(&f.buyer, &f.supplier, &f.buyer, &f.resolver),
        Err(Ok(Error::InvalidAttestor)),
    );
    // A supplier who can attest their own work defeats verification.
    assert_eq!(
        f.client
            .try_create_order(&f.buyer, &f.supplier, &f.supplier, &f.resolver),
        Err(Ok(Error::InvalidAttestor)),
    );
}

#[test]
fn create_order_rejects_resolver_who_is_a_counterparty() {
    let f = setup();

    assert_eq!(
        f.client
            .try_create_order(&f.buyer, &f.supplier, &f.attestor, &f.buyer),
        Err(Ok(Error::InvalidResolver)),
    );
    assert_eq!(
        f.client
            .try_create_order(&f.buyer, &f.supplier, &f.attestor, &f.supplier),
        Err(Ok(Error::InvalidResolver)),
    );
}

#[test]
fn create_order_rejects_an_attestor_who_is_also_the_resolver() {
    let f = setup();

    // Separation of duties: the resolver reviews disputes about the attestor's
    // verification, so one account must not hold both roles.
    assert_eq!(
        f.client
            .try_create_order(&f.buyer, &f.supplier, &f.attestor, &f.attestor),
        Err(Ok(Error::AttestorResolverConflict)),
    );
}

#[test]
fn create_order_accepts_four_distinct_parties() {
    let f = setup();

    // The independence rules must not block the ordinary four-party case.
    let order_id = f
        .client
        .create_order(&f.buyer, &f.supplier, &f.attestor, &f.resolver);
    let order = f.client.get_order(&order_id);

    assert_ne!(order.attestor, order.resolver);
    assert_ne!(order.attestor, order.buyer);
    assert_ne!(order.attestor, order.supplier);
    assert_ne!(order.resolver, order.buyer);
    assert_ne!(order.resolver, order.supplier);
}

#[test]
fn create_order_requires_buyer_authorization() {
    let f = setup();

    f.env.mock_auths(&[MockAuth {
        address: &f.outsider,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "create_order",
            args: (
                f.buyer.clone(),
                f.supplier.clone(),
                f.attestor.clone(),
                f.resolver.clone(),
            )
                .into_val(&f.env),
            sub_invokes: &[],
        },
    }]);

    let result = f
        .client
        .try_create_order(&f.buyer, &f.supplier, &f.attestor, &f.resolver);

    assert!(
        result.is_err(),
        "an outsider must not create a buyer's order"
    );
}

// ---------------------------------------------------------------------------
// create_milestone
// ---------------------------------------------------------------------------

#[test]
fn create_milestone_links_to_order_and_starts_unfunded() {
    let f = setup();
    let order_id = f
        .client
        .create_order(&f.buyer, &f.supplier, &f.attestor, &f.resolver);

    let milestone_id = f.client.create_milestone(&order_id, &AMOUNT_M1, &None);
    let milestone = f.client.get_milestone(&milestone_id);

    assert_eq!(milestone.id, milestone_id);
    assert_eq!(milestone.order_id, order_id);
    assert_eq!(milestone.index, 0);
    assert_eq!(milestone.amount, AMOUNT_M1);
    assert_eq!(milestone.deadline, None);
    // No escrow exists yet: buyer money cannot be in the contract before PKG-02.
    assert_eq!(milestone.funded_amount, 0);
    assert_eq!(milestone.status, MilestoneStatus::Unfunded);
}

#[test]
fn milestones_are_indexed_in_creation_order() {
    let f = setup();
    let order_id = f
        .client
        .create_order(&f.buyer, &f.supplier, &f.attestor, &f.resolver);

    let m1 = f.client.create_milestone(&order_id, &AMOUNT_M1, &None);
    let m2 = f.client.create_milestone(&order_id, &AMOUNT_M2, &None);

    assert_eq!((m1, m2), (1, 2));
    assert_eq!(f.client.get_milestone(&m1).index, 0);
    assert_eq!(f.client.get_milestone(&m2).index, 1);

    let milestone_ids = f.client.get_order_milestones(&order_id);
    assert_eq!(milestone_ids.len(), 2);
    assert_eq!(milestone_ids.get(0), Some(m1));
    assert_eq!(milestone_ids.get(1), Some(m2));
    assert_eq!(f.client.milestone_count(), 2);
}

#[test]
fn milestone_ids_are_unique_across_orders() {
    let f = setup();
    let order_a = f
        .client
        .create_order(&f.buyer, &f.supplier, &f.attestor, &f.resolver);
    let order_b = f
        .client
        .create_order(&f.buyer, &f.supplier, &f.attestor, &f.resolver);

    let a1 = f.client.create_milestone(&order_a, &AMOUNT_M1, &None);
    let b1 = f.client.create_milestone(&order_b, &AMOUNT_M1, &None);

    assert_ne!(a1, b1);
    // Each milestone resolves back to exactly one order: no cross-order aliasing.
    assert_eq!(f.client.get_milestone(&a1).order_id, order_a);
    assert_eq!(f.client.get_milestone(&b1).order_id, order_b);
    assert_eq!(f.client.get_order_milestones(&order_a).len(), 1);
    assert_eq!(f.client.get_order_milestones(&order_b).len(), 1);
}

#[test]
fn create_milestone_rejects_non_positive_amounts() {
    let f = setup();
    let order_id = f
        .client
        .create_order(&f.buyer, &f.supplier, &f.attestor, &f.resolver);

    assert_eq!(
        f.client.try_create_milestone(&order_id, &0, &None),
        Err(Ok(Error::InvalidAmount)),
    );
    assert_eq!(
        f.client.try_create_milestone(&order_id, &-1, &None),
        Err(Ok(Error::InvalidAmount)),
    );
}

#[test]
fn create_milestone_rejects_a_deadline_in_the_past() {
    let f = setup();
    f.env.ledger().with_mut(|ledger| ledger.timestamp = 1_000);

    let order_id = f
        .client
        .create_order(&f.buyer, &f.supplier, &f.attestor, &f.resolver);

    assert_eq!(
        f.client
            .try_create_milestone(&order_id, &AMOUNT_M1, &Some(999)),
        Err(Ok(Error::InvalidDeadline)),
    );
    assert_eq!(
        f.client
            .try_create_milestone(&order_id, &AMOUNT_M1, &Some(1_000)),
        Err(Ok(Error::InvalidDeadline)),
    );

    // A future deadline is accepted and stored verbatim.
    let milestone_id = f
        .client
        .create_milestone(&order_id, &AMOUNT_M1, &Some(2_000));
    assert_eq!(f.client.get_milestone(&milestone_id).deadline, Some(2_000));
}

#[test]
fn create_milestone_rejects_unknown_order() {
    let f = setup();
    assert_eq!(
        f.client.try_create_milestone(&999, &AMOUNT_M1, &None),
        Err(Ok(Error::OrderNotFound)),
    );
}

#[test]
fn create_milestone_requires_buyer_authorization() {
    let f = setup();
    let order_id = f
        .client
        .create_order(&f.buyer, &f.supplier, &f.attestor, &f.resolver);

    // The supplier is a party to the order but must not define its milestones.
    f.env.mock_auths(&[MockAuth {
        address: &f.supplier,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "create_milestone",
            args: (order_id, AMOUNT_M1, None::<u64>).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);

    let result = f.client.try_create_milestone(&order_id, &AMOUNT_M1, &None);

    assert!(
        result.is_err(),
        "only the buyer may add milestones to their order"
    );
}

#[test]
fn create_milestone_enforces_the_per_order_limit() {
    let f = setup();
    let order_id = f
        .client
        .create_order(&f.buyer, &f.supplier, &f.attestor, &f.resolver);

    for _ in 0..MAX_MILESTONES_PER_ORDER {
        f.client.create_milestone(&order_id, &AMOUNT_M1, &None);
    }

    assert_eq!(
        f.client.try_create_milestone(&order_id, &AMOUNT_M1, &None),
        Err(Ok(Error::MilestoneLimitReached)),
    );
    assert_eq!(
        f.client.get_order_milestones(&order_id).len(),
        MAX_MILESTONES_PER_ORDER
    );
}

// ---------------------------------------------------------------------------
// accept_order
// ---------------------------------------------------------------------------

#[test]
fn accept_order_activates_the_order() {
    let f = setup();
    let order_id = f.order_with_milestone();

    f.client.accept_order(&order_id);

    assert_eq!(f.client.get_order(&order_id).status, OrderStatus::Active);
}

#[test]
fn accept_order_rejects_an_order_without_milestones() {
    let f = setup();
    let order_id = f
        .client
        .create_order(&f.buyer, &f.supplier, &f.attestor, &f.resolver);

    assert_eq!(
        f.client.try_accept_order(&order_id),
        Err(Ok(Error::OrderHasNoMilestones)),
    );
}

#[test]
fn accept_order_cannot_be_repeated() {
    let f = setup();
    let order_id = f.active_order();

    assert_eq!(
        f.client.try_accept_order(&order_id),
        Err(Ok(Error::InvalidOrderStatus)),
    );
}

#[test]
fn accept_order_requires_the_assigned_supplier() {
    let f = setup();
    let order_id = f.order_with_milestone();

    f.env.mock_auths(&[MockAuth {
        address: &f.outsider,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "accept_order",
            args: (order_id,).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);

    assert!(
        f.client.try_accept_order(&order_id).is_err(),
        "only the assigned supplier may accept the order"
    );
    assert_eq!(f.client.get_order(&order_id).status, OrderStatus::Created);
}

#[test]
fn accept_order_rejects_unknown_order() {
    let f = setup();
    assert_eq!(
        f.client.try_accept_order(&999),
        Err(Ok(Error::OrderNotFound)),
    );
}

// ---------------------------------------------------------------------------
// Milestone-set immutability after acceptance
// ---------------------------------------------------------------------------

#[test]
fn milestones_cannot_be_added_after_acceptance() {
    let f = setup();
    let order_id = f.active_order();

    // The supplier committed to a known scope; the buyer cannot enlarge it.
    assert_eq!(
        f.client.try_create_milestone(&order_id, &AMOUNT_M2, &None),
        Err(Ok(Error::InvalidOrderStatus)),
    );
    assert_eq!(f.client.get_order_milestones(&order_id).len(), 1);
}

#[test]
fn order_actors_and_asset_are_unchanged_by_later_calls() {
    let f = setup();
    let order_id = f.order_with_milestone();
    let before = f.client.get_order(&order_id);

    f.client.create_milestone(&order_id, &AMOUNT_M2, &None);
    f.client.accept_order(&order_id);
    let after = f.client.get_order(&order_id);

    assert_eq!(before.buyer, after.buyer);
    assert_eq!(before.supplier, after.supplier);
    assert_eq!(before.attestor, after.attestor);
    assert_eq!(before.resolver, after.resolver);
    assert_eq!(before.asset, after.asset);
    assert_eq!(before.created_at, after.created_at);
    // Only status advanced.
    assert_eq!(before.status, OrderStatus::Created);
    assert_eq!(after.status, OrderStatus::Active);
}

// ---------------------------------------------------------------------------
// cancel_order
// ---------------------------------------------------------------------------

#[test]
fn cancel_order_cancels_an_unaccepted_order() {
    let f = setup();
    let order_id = f.order_with_milestone();

    f.client.cancel_order(&order_id);

    assert_eq!(f.client.get_order(&order_id).status, OrderStatus::Cancelled);
}

#[test]
fn cancel_order_rejects_an_active_order() {
    let f = setup();
    let order_id = f.active_order();

    // Unwinding an accepted order is dispute/refund territory, not cancellation.
    assert_eq!(
        f.client.try_cancel_order(&order_id),
        Err(Ok(Error::InvalidOrderStatus)),
    );
    assert_eq!(f.client.get_order(&order_id).status, OrderStatus::Active);
}

#[test]
fn cancelled_order_is_terminal() {
    let f = setup();
    let order_id = f.order_with_milestone();
    f.client.cancel_order(&order_id);

    assert_eq!(
        f.client.try_accept_order(&order_id),
        Err(Ok(Error::InvalidOrderStatus)),
    );
    assert_eq!(
        f.client.try_cancel_order(&order_id),
        Err(Ok(Error::InvalidOrderStatus)),
    );
    assert_eq!(
        f.client.try_create_milestone(&order_id, &AMOUNT_M1, &None),
        Err(Ok(Error::InvalidOrderStatus)),
    );
}

#[test]
fn cancel_order_requires_the_buyer() {
    let f = setup();
    let order_id = f.order_with_milestone();

    f.env.mock_auths(&[MockAuth {
        address: &f.supplier,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "cancel_order",
            args: (order_id,).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);

    assert!(
        f.client.try_cancel_order(&order_id).is_err(),
        "only the buyer may cancel their order"
    );
    assert_eq!(f.client.get_order(&order_id).status, OrderStatus::Created);
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

#[test]
fn reads_reject_unknown_entities() {
    let f = setup();

    assert_eq!(f.client.try_get_order(&999), Err(Ok(Error::OrderNotFound)));
    assert_eq!(
        f.client.try_get_milestone(&999),
        Err(Ok(Error::MilestoneNotFound)),
    );
    assert_eq!(
        f.client.try_get_order_milestones(&999),
        Err(Ok(Error::OrderNotFound)),
    );
}

#[test]
fn counters_start_at_zero() {
    let f = setup();
    assert_eq!(f.client.order_count(), 0);
    assert_eq!(f.client.milestone_count(), 0);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[test]
fn create_order_emits_order_created() {
    let f = setup();
    f.client
        .create_order(&f.buyer, &f.supplier, &f.attestor, &f.resolver);

    assert_eq!(f.event_count(), 1);
    assert_eq!(f.last_event_name(), Symbol::new(&f.env, "order_created"));
}

#[test]
fn create_milestone_emits_milestone_created() {
    let f = setup();
    let order_id = f
        .client
        .create_order(&f.buyer, &f.supplier, &f.attestor, &f.resolver);
    f.client.create_milestone(&order_id, &AMOUNT_M1, &None);

    assert_eq!(f.event_count(), 1);
    assert_eq!(
        f.last_event_name(),
        Symbol::new(&f.env, "milestone_created")
    );
}

#[test]
fn accept_order_emits_order_accepted() {
    let f = setup();
    f.active_order();

    assert_eq!(f.last_event_name(), Symbol::new(&f.env, "order_accepted"));
}

#[test]
fn cancel_order_emits_order_cancelled() {
    let f = setup();
    let order_id = f.order_with_milestone();
    f.client.cancel_order(&order_id);

    assert_eq!(f.last_event_name(), Symbol::new(&f.env, "order_cancelled"));
}

#[test]
fn rejected_calls_emit_no_events() {
    let f = setup();
    let order_id = f
        .client
        .create_order(&f.buyer, &f.supplier, &f.attestor, &f.resolver);
    assert_eq!(f.event_count(), 1, "a successful call emits its event");

    // A guard that rejects must leave no trace for the indexer to pick up.
    let _ = f.client.try_create_milestone(&order_id, &0, &None);
    assert_eq!(f.event_count(), 0, "an invalid amount must emit nothing");

    let _ = f.client.try_accept_order(&order_id);
    assert_eq!(
        f.event_count(),
        0,
        "a rejected transition must emit nothing"
    );
}

// ===========================================================================
// PKG-02 — Buyer milestone escrow
// ===========================================================================

#[test]
fn funding_moves_buyer_money_into_contract_escrow() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();

    let funded = f.client.fund_milestone(&m1, &AMOUNT_M1, &f.usdc);

    assert_eq!(funded, AMOUNT_M1);
    assert_eq!(f.balance(&f.buyer), BUYER_INITIAL_BALANCE - AMOUNT_M1);
    // The money is held by the contract, under contract control.
    assert_eq!(f.escrow_balance(), AMOUNT_M1);
    assert_eq!(f.client.get_milestone(&m1).funded_amount, AMOUNT_M1);
}

#[test]
fn buyer_escrow_is_not_supplier_working_capital() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();

    f.client.fund_milestone(&m1, &AMOUNT_M1, &f.usdc);

    // Funding a milestone pays the supplier nothing. The supplier's early
    // liquidity comes from a funder's own capital in PKG-03, never from here.
    assert_eq!(f.balance(&f.supplier), 0);
    assert_eq!(f.escrow_balance(), AMOUNT_M1);
    // No status implies the supplier may draw on it.
    assert_eq!(f.client.get_milestone(&m1).status, MilestoneStatus::Funded);
}

#[test]
fn exact_full_funding_transitions_to_funded_and_becomes_financeable() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();

    assert!(!f.client.is_fully_funded(&m1));
    assert_eq!(
        f.client.get_milestone(&m1).status,
        MilestoneStatus::Unfunded
    );

    f.client.fund_milestone(&m1, &AMOUNT_M1, &f.usdc);

    assert!(f.client.is_fully_funded(&m1));
    assert_eq!(f.client.get_milestone(&m1).status, MilestoneStatus::Funded);
}

#[test]
fn a_partially_funded_milestone_is_not_financeable() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();
    let half = AMOUNT_M1 / 2;

    let funded = f.client.fund_milestone(&m1, &half, &f.usdc);

    assert_eq!(funded, half);
    assert_eq!(f.escrow_balance(), half);
    // Partial protection must never read as fully protected (invariant 23):
    // the funder's underwriting input would otherwise be ambiguous.
    assert!(!f.client.is_fully_funded(&m1));
    assert_eq!(
        f.client.get_milestone(&m1).status,
        MilestoneStatus::Unfunded
    );
}

#[test]
fn partial_deposits_accumulate_to_full_protection() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();
    let first = AMOUNT_M1 / 4;
    let second = AMOUNT_M1 - first;

    assert_eq!(f.client.fund_milestone(&m1, &first, &f.usdc), first);
    assert_eq!(
        f.client.get_milestone(&m1).status,
        MilestoneStatus::Unfunded
    );

    assert_eq!(f.client.fund_milestone(&m1, &second, &f.usdc), AMOUNT_M1);
    assert_eq!(f.client.get_milestone(&m1).status, MilestoneStatus::Funded);
    assert_eq!(f.escrow_balance(), AMOUNT_M1);
}

#[test]
fn overfunding_is_rejected() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();

    assert_eq!(
        f.client.try_fund_milestone(&m1, &(AMOUNT_M1 + 1), &f.usdc),
        Err(Ok(Error::Overfunded)),
    );
    // Nothing moved.
    assert_eq!(f.escrow_balance(), 0);
    assert_eq!(f.balance(&f.buyer), BUYER_INITIAL_BALANCE);
}

#[test]
fn a_partial_deposit_cannot_be_topped_up_past_the_milestone_amount() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();
    let half = AMOUNT_M1 / 2;
    f.client.fund_milestone(&m1, &half, &f.usdc);

    assert_eq!(
        f.client.try_fund_milestone(&m1, &(half + 1), &f.usdc),
        Err(Ok(Error::Overfunded)),
    );
    assert_eq!(f.escrow_balance(), half);
    assert_eq!(f.client.get_milestone(&m1).funded_amount, half);
}

#[test]
fn a_fully_funded_milestone_cannot_be_funded_again() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();
    f.client.fund_milestone(&m1, &AMOUNT_M1, &f.usdc);

    assert_eq!(
        f.client.try_fund_milestone(&m1, &1, &f.usdc),
        Err(Ok(Error::InvalidMilestoneStatus)),
    );
    assert_eq!(f.escrow_balance(), AMOUNT_M1);
}

#[test]
fn funding_rejects_a_non_approved_asset() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();

    assert_eq!(
        f.client.try_fund_milestone(&m1, &AMOUNT_M1, &f.other_asset),
        Err(Ok(Error::InvalidAsset)),
    );
    // Neither asset moved.
    assert_eq!(f.escrow_balance(), 0);
    assert_eq!(
        TokenClient::new(&f.env, &f.other_asset).balance(&f.contract_id),
        0
    );
}

#[test]
fn funding_rejects_non_positive_amounts() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();

    assert_eq!(
        f.client.try_fund_milestone(&m1, &0, &f.usdc),
        Err(Ok(Error::InvalidAmount)),
    );
    assert_eq!(
        f.client.try_fund_milestone(&m1, &-AMOUNT_M1, &f.usdc),
        Err(Ok(Error::InvalidAmount)),
    );
    assert_eq!(f.escrow_balance(), 0);
    assert_eq!(f.balance(&f.buyer), BUYER_INITIAL_BALANCE);
}

#[test]
fn funding_rejects_unknown_milestone() {
    let f = setup();
    assert_eq!(
        f.client.try_fund_milestone(&999, &AMOUNT_M1, &f.usdc),
        Err(Ok(Error::MilestoneNotFound)),
    );
}

#[test]
fn funding_requires_an_active_order() {
    let f = setup();
    // Order created but not yet accepted by the supplier.
    let order_id = f
        .client
        .create_order(&f.buyer, &f.supplier, &f.attestor, &f.resolver);
    let m1 = f.client.create_milestone(&order_id, &AMOUNT_M1, &None);

    assert_eq!(
        f.client.try_fund_milestone(&m1, &AMOUNT_M1, &f.usdc),
        Err(Ok(Error::InvalidOrderStatus)),
    );
    assert_eq!(f.escrow_balance(), 0);
}

#[test]
fn a_cancelled_order_can_never_hold_escrow() {
    let f = setup();
    let order_id = f.order_with_milestone();
    let milestone_id = f.client.get_order_milestones(&order_id).get(0).unwrap();
    f.client.cancel_order(&order_id);

    // cancel_order is Created-only and funding is Active-only, so the two are
    // permanently disjoint: no cancelled order can hold buyer money.
    assert_eq!(
        f.client
            .try_fund_milestone(&milestone_id, &AMOUNT_M1, &f.usdc),
        Err(Ok(Error::InvalidOrderStatus)),
    );
    assert_eq!(f.escrow_balance(), 0);
}

#[test]
fn only_the_buyer_may_fund_a_milestone() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();

    for impostor in [f.supplier.clone(), f.outsider.clone()] {
        f.env.mock_auths(&[MockAuth {
            address: &impostor,
            invoke: &MockAuthInvoke {
                contract: &f.contract_id,
                fn_name: "fund_milestone",
                args: (m1, AMOUNT_M1, f.usdc.clone()).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);

        assert!(
            f.client
                .try_fund_milestone(&m1, &AMOUNT_M1, &f.usdc)
                .is_err(),
            "only the buyer may fund milestone escrow"
        );
    }

    assert_eq!(f.escrow_balance(), 0);
}

// ---------------------------------------------------------------------------
// Cross-milestone isolation
// ---------------------------------------------------------------------------

#[test]
fn funding_one_milestone_does_not_fund_another() {
    let f = setup();
    let (_, m1, m2) = f.active_order_with_two_milestones();

    f.client.fund_milestone(&m1, &AMOUNT_M1, &f.usdc);

    assert_eq!(f.client.get_milestone(&m2).funded_amount, 0);
    assert_eq!(
        f.client.get_milestone(&m2).status,
        MilestoneStatus::Unfunded
    );
    assert!(!f.client.is_fully_funded(&m2));
}

#[test]
fn escrow_is_credited_per_milestone_and_sums_to_the_contract_balance() {
    let f = setup();
    let (_, m1, m2) = f.active_order_with_two_milestones();

    f.client.fund_milestone(&m1, &AMOUNT_M1, &f.usdc);
    f.client.fund_milestone(&m2, &AMOUNT_M2, &f.usdc);

    assert_eq!(f.client.get_milestone(&m1).funded_amount, AMOUNT_M1);
    assert_eq!(f.client.get_milestone(&m2).funded_amount, AMOUNT_M2);
    // Per-milestone accounting reconciles exactly with custody.
    assert_eq!(f.escrow_balance(), AMOUNT_M1 + AMOUNT_M2);
}

#[test]
fn escrow_does_not_leak_between_separate_orders() {
    let f = setup();
    let (_, order_a_m1, _) = f.active_order_with_two_milestones();
    let (_, order_b_m1, _) = f.active_order_with_two_milestones();

    f.client.fund_milestone(&order_a_m1, &AMOUNT_M1, &f.usdc);

    assert_eq!(f.client.get_milestone(&order_b_m1).funded_amount, 0);
    assert_eq!(f.escrow_balance(), AMOUNT_M1);
}

// ---------------------------------------------------------------------------
// Escrow release primitive (internal; consumed by PKG-04)
// ---------------------------------------------------------------------------

#[test]
fn escrow_release_cannot_exceed_what_the_milestone_holds() {
    let f = setup();
    let (order_id, m1, _) = f.active_order_with_two_milestones();
    f.client.fund_milestone(&m1, &AMOUNT_M1, &f.usdc);

    f.env.as_contract(&f.contract_id, || {
        let order = crate::storage::read_order(&f.env, order_id).unwrap();
        let mut milestone = crate::storage::read_milestone(&f.env, m1).unwrap();

        let result =
            crate::escrow::release(&f.env, &order, &mut milestone, &f.supplier, AMOUNT_M1 + 1);

        assert_eq!(result, Err(Error::InsufficientEscrow));
        assert_eq!(milestone.funded_amount, AMOUNT_M1);
    });

    // No payout happened.
    assert_eq!(f.balance(&f.supplier), 0);
    assert_eq!(f.escrow_balance(), AMOUNT_M1);
}

#[test]
fn escrow_release_debits_the_milestone_it_pays_from() {
    let f = setup();
    let (order_id, m1, m2) = f.active_order_with_two_milestones();
    f.client.fund_milestone(&m1, &AMOUNT_M1, &f.usdc);
    f.client.fund_milestone(&m2, &AMOUNT_M2, &f.usdc);

    f.env.as_contract(&f.contract_id, || {
        let order = crate::storage::read_order(&f.env, order_id).unwrap();
        let mut milestone = crate::storage::read_milestone(&f.env, m1).unwrap();

        crate::escrow::release(&f.env, &order, &mut milestone, &f.supplier, AMOUNT_M1).unwrap();

        assert_eq!(milestone.funded_amount, 0);
        crate::storage::write_milestone(&f.env, &milestone);
    });

    // The payout came out of M1's escrow only; M2 is untouched.
    assert_eq!(f.balance(&f.supplier), AMOUNT_M1);
    assert_eq!(f.client.get_milestone(&m2).funded_amount, AMOUNT_M2);
    assert_eq!(f.escrow_balance(), AMOUNT_M2);
}

#[test]
fn escrow_release_rejects_non_positive_amounts() {
    let f = setup();
    let (order_id, m1, _) = f.active_order_with_two_milestones();
    f.client.fund_milestone(&m1, &AMOUNT_M1, &f.usdc);

    f.env.as_contract(&f.contract_id, || {
        let order = crate::storage::read_order(&f.env, order_id).unwrap();
        let mut milestone = crate::storage::read_milestone(&f.env, m1).unwrap();

        assert_eq!(
            crate::escrow::release(&f.env, &order, &mut milestone, &f.supplier, 0),
            Err(Error::InvalidAmount),
        );
        assert_eq!(
            crate::escrow::release(&f.env, &order, &mut milestone, &f.supplier, -1),
            Err(Error::InvalidAmount),
        );
        assert_eq!(milestone.funded_amount, AMOUNT_M1);
    });
}

// ---------------------------------------------------------------------------
// TTL — a funded milestone must survive a long shipment window
// ---------------------------------------------------------------------------

#[test]
fn funding_extends_the_milestone_entry_ttl() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();

    f.client.fund_milestone(&m1, &AMOUNT_M1, &f.usdc);

    assert_eq!(f.milestone_ttl(m1), PERSISTENT_BUMP_AMOUNT);
    assert_eq!(f.instance_ttl(), INSTANCE_BUMP_AMOUNT);
}

#[test]
fn funded_escrow_survives_a_long_shipment_window() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();
    f.client.fund_milestone(&m1, &AMOUNT_M1, &f.usdc);

    // Weeks pass while goods are in transit.
    f.env
        .ledger()
        .set_sequence_number(f.env.ledger().sequence() + LONG_SHIPMENT_LEDGERS);

    // The protected amount is still readable and still intact.
    let milestone = f.client.get_milestone(&m1);
    assert_eq!(milestone.funded_amount, AMOUNT_M1);
    assert_eq!(milestone.status, MilestoneStatus::Funded);
    assert_eq!(f.escrow_balance(), AMOUNT_M1);
}

#[test]
fn reading_a_funded_milestone_re_extends_its_ttl() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();
    f.client.fund_milestone(&m1, &AMOUNT_M1, &f.usdc);

    f.env
        .ledger()
        .set_sequence_number(f.env.ledger().sequence() + LONG_SHIPMENT_LEDGERS);
    let ttl_before = f.milestone_ttl(m1);
    assert!(
        ttl_before < PERSISTENT_BUMP_AMOUNT,
        "the window should have consumed part of the TTL"
    );

    f.client.get_milestone(&m1);

    // An actively used order cannot quietly archive itself mid-trade.
    assert_eq!(f.milestone_ttl(m1), PERSISTENT_BUMP_AMOUNT);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[test]
fn funding_emits_milestone_funded() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();

    f.client.fund_milestone(&m1, &AMOUNT_M1, &f.usdc);

    assert_eq!(f.last_event_name(), Symbol::new(&f.env, "milestone_funded"));
}

#[test]
fn rejected_funding_emits_nothing_and_moves_no_money() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();

    let _ = f.client.try_fund_milestone(&m1, &(AMOUNT_M1 + 1), &f.usdc);

    assert_eq!(f.event_count(), 0);
    assert_eq!(f.escrow_balance(), 0);
    assert_eq!(f.balance(&f.buyer), BUYER_INITIAL_BALANCE);
}

// ===========================================================================
// PKG-03 — Finance requests
// ===========================================================================

#[test]
fn request_finance_opens_a_fully_protected_milestone_to_offers() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();
    f.client.fund_milestone(&m1, &AMOUNT_M1, &f.usdc);

    let expires = f.now() + REQUEST_TTL;
    f.client.request_finance(&m1, &PRINCIPAL, &expires);

    let request = f.client.get_finance_request(&m1);
    assert_eq!(request.milestone_id, m1);
    assert_eq!(request.supplier, f.supplier);
    assert_eq!(request.requested_principal, PRINCIPAL);
    assert_eq!(request.status, FinanceRequestStatus::Open);
    assert_eq!(request.expires_at, expires);
    assert_eq!(
        f.client.get_milestone(&m1).status,
        MilestoneStatus::FinanceRequested
    );
    // Requesting finance moves no money at all.
    assert_eq!(f.balance(&f.supplier), 0);
    assert_eq!(f.escrow_balance(), AMOUNT_M1);
}

#[test]
fn request_finance_rejects_an_underfunded_milestone() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();
    // Only half protected.
    f.client.fund_milestone(&m1, &(AMOUNT_M1 / 2), &f.usdc);

    // The milestone never reached Funded, so it is not financeable
    // (invariant 23). The status guard is what rejects it.
    assert_eq!(
        f.client
            .try_request_finance(&m1, &PRINCIPAL, &(f.now() + REQUEST_TTL)),
        Err(Ok(Error::InvalidMilestoneStatus)),
    );
    assert!(!f.client.is_fully_funded(&m1));
}

#[test]
fn request_finance_rejects_a_completely_unfunded_milestone() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();

    assert_eq!(
        f.client
            .try_request_finance(&m1, &PRINCIPAL, &(f.now() + REQUEST_TTL)),
        Err(Ok(Error::InvalidMilestoneStatus)),
    );
}

#[test]
fn request_finance_rejects_a_principal_above_the_protected_amount() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();
    f.client.fund_milestone(&m1, &AMOUNT_M1, &f.usdc);

    // Repayment >= principal and repayment <= escrow, so a principal above the
    // protected amount could never be offered against.
    assert_eq!(
        f.client
            .try_request_finance(&m1, &(AMOUNT_M1 + 1), &(f.now() + REQUEST_TTL)),
        Err(Ok(Error::RepaymentExceedsEscrow)),
    );
}

#[test]
fn request_finance_rejects_non_positive_principal() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();
    f.client.fund_milestone(&m1, &AMOUNT_M1, &f.usdc);

    assert_eq!(
        f.client
            .try_request_finance(&m1, &0, &(f.now() + REQUEST_TTL)),
        Err(Ok(Error::InvalidAmount)),
    );
    assert_eq!(
        f.client
            .try_request_finance(&m1, &-PRINCIPAL, &(f.now() + REQUEST_TTL)),
        Err(Ok(Error::InvalidAmount)),
    );
}

#[test]
fn request_finance_validates_the_expiry_window() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();
    f.client.fund_milestone(&m1, &AMOUNT_M1, &f.usdc);
    f.advance_time(1_000);

    // In the past.
    assert_eq!(
        f.client
            .try_request_finance(&m1, &PRINCIPAL, &(f.now() - 1)),
        Err(Ok(Error::InvalidExpiry)),
    );
    // Beyond the allowed window.
    assert_eq!(
        f.client.try_request_finance(
            &m1,
            &PRINCIPAL,
            &(f.now() + MAX_REQUEST_VALIDITY_SECONDS + 1)
        ),
        Err(Ok(Error::InvalidExpiry)),
    );
}

#[test]
fn request_finance_requires_the_supplier() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();
    f.client.fund_milestone(&m1, &AMOUNT_M1, &f.usdc);
    let expires = f.now() + REQUEST_TTL;

    for impostor in [f.buyer.clone(), f.funder_a.clone()] {
        f.env.mock_auths(&[MockAuth {
            address: &impostor,
            invoke: &MockAuthInvoke {
                contract: &f.contract_id,
                fn_name: "request_finance",
                args: (m1, PRINCIPAL, expires).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        assert!(
            f.client
                .try_request_finance(&m1, &PRINCIPAL, &expires)
                .is_err(),
            "only the supplier may request financing"
        );
    }
}

#[test]
fn a_second_finance_request_while_one_is_live_is_rejected() {
    let f = setup();
    let (_, m1, _) = f.milestone_seeking_finance();

    assert_eq!(
        f.client
            .try_request_finance(&m1, &PRINCIPAL, &(f.now() + REQUEST_TTL)),
        Err(Ok(Error::FinanceRequestActive)),
    );
}

#[test]
fn an_expired_request_can_be_replaced_so_the_milestone_is_never_stranded() {
    let f = setup();
    let (_, m1, _) = f.milestone_seeking_finance();

    f.advance_time(REQUEST_TTL + 1);

    let expires = f.now() + REQUEST_TTL;
    f.client.request_finance(&m1, &PRINCIPAL, &expires);

    let request = f.client.get_finance_request(&m1);
    assert_eq!(request.status, FinanceRequestStatus::Open);
    assert_eq!(request.expires_at, expires);
    // The stale round's offer index does not carry over.
    assert!(f.client.get_open_offers(&m1).is_empty());
}

// ===========================================================================
// PKG-03 — Funding offers
// ===========================================================================

#[test]
fn funders_compete_on_repayment() {
    let f = setup();
    let (_, m1, _) = f.milestone_seeking_finance();

    let (offer_a, offer_b) = f.competing_offers(m1);

    assert_eq!((offer_a, offer_b), (1, 2));
    let a = f.client.get_offer(&offer_a);
    let b = f.client.get_offer(&offer_b);
    assert_eq!(a.funder, f.funder_a);
    assert_eq!(a.repayment, REPAYMENT_A);
    assert_eq!(b.repayment, REPAYMENT_B);
    // Same principal, so the supplier compares on repayment alone.
    assert_eq!(a.principal, b.principal);
    assert_eq!(f.client.get_open_offers(&m1).len(), 2);
    // Making an offer commits no capital.
    assert_eq!(f.balance(&f.funder_a), FUNDER_INITIAL_BALANCE);
    assert_eq!(f.balance(&f.funder_b), FUNDER_INITIAL_BALANCE);
}

#[test]
fn make_offer_requires_the_exact_requested_principal() {
    let f = setup();
    let (_, m1, _) = f.milestone_seeking_finance();
    let expires = f.now() + OFFER_TTL;

    assert_eq!(
        f.client
            .try_make_offer(&m1, &f.funder_a, &(PRINCIPAL - 1), &REPAYMENT_A, &expires),
        Err(Ok(Error::PrincipalMismatch)),
    );
}

#[test]
fn make_offer_rejects_repayment_below_principal() {
    let f = setup();
    let (_, m1, _) = f.milestone_seeking_finance();

    assert_eq!(
        f.client.try_make_offer(
            &m1,
            &f.funder_a,
            &PRINCIPAL,
            &(PRINCIPAL - 1),
            &(f.now() + OFFER_TTL)
        ),
        Err(Ok(Error::InvalidRepayment)),
    );
}

#[test]
fn make_offer_rejects_repayment_greater_than_protected_escrow() {
    let f = setup();
    let (_, m1, _) = f.milestone_seeking_finance();

    // The verified milestone can never pay out more than it holds, so a
    // repayment above protected escrow must be impossible to offer.
    assert_eq!(
        f.client.try_make_offer(
            &m1,
            &f.funder_a,
            &PRINCIPAL,
            &(AMOUNT_M1 + 1),
            &(f.now() + OFFER_TTL)
        ),
        Err(Ok(Error::RepaymentExceedsEscrow)),
    );

    // Exactly the protected amount is the ceiling, and is allowed.
    f.client.make_offer(
        &m1,
        &f.funder_a,
        &PRINCIPAL,
        &AMOUNT_M1,
        &(f.now() + OFFER_TTL),
    );
}

#[test]
fn make_offer_rejects_a_funder_who_holds_another_role() {
    let f = setup();
    let (_, m1, _) = f.milestone_seeking_finance();
    let expires = f.now() + OFFER_TTL;

    for conflicted in [
        f.buyer.clone(),
        f.supplier.clone(),
        f.attestor.clone(),
        f.resolver.clone(),
    ] {
        assert_eq!(
            f.client
                .try_make_offer(&m1, &conflicted, &PRINCIPAL, &REPAYMENT_A, &expires),
            Err(Ok(Error::InvalidFunder)),
            "the funder must be independent of every other role",
        );
    }
}

#[test]
fn make_offer_requires_the_funders_own_authorization() {
    let f = setup();
    let (_, m1, _) = f.milestone_seeking_finance();
    let expires = f.now() + OFFER_TTL;

    f.env.mock_auths(&[MockAuth {
        address: &f.outsider,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "make_offer",
            args: (m1, f.funder_a.clone(), PRINCIPAL, REPAYMENT_A, expires).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);

    assert!(
        f.client
            .try_make_offer(&m1, &f.funder_a, &PRINCIPAL, &REPAYMENT_A, &expires)
            .is_err(),
        "nobody may post an offer in another funder's name"
    );
}

#[test]
fn make_offer_rejects_a_milestone_that_is_not_seeking_finance() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();
    f.client.fund_milestone(&m1, &AMOUNT_M1, &f.usdc);

    assert_eq!(
        f.client.try_make_offer(
            &m1,
            &f.funder_a,
            &PRINCIPAL,
            &REPAYMENT_A,
            &(f.now() + OFFER_TTL)
        ),
        Err(Ok(Error::FinanceRequestNotFound)),
    );
}

#[test]
fn make_offer_rejects_an_expired_request() {
    let f = setup();
    let (_, m1, _) = f.milestone_seeking_finance();
    f.advance_time(REQUEST_TTL + 1);

    assert_eq!(
        f.client.try_make_offer(
            &m1,
            &f.funder_a,
            &PRINCIPAL,
            &REPAYMENT_A,
            &(f.now() + OFFER_TTL)
        ),
        Err(Ok(Error::FinanceRequestExpired)),
    );
}

#[test]
fn make_offer_validates_the_offer_expiry_window() {
    let f = setup();
    let (_, m1, _) = f.milestone_seeking_finance();
    f.advance_time(1_000);

    assert_eq!(
        f.client
            .try_make_offer(&m1, &f.funder_a, &PRINCIPAL, &REPAYMENT_A, &(f.now() - 1)),
        Err(Ok(Error::InvalidExpiry)),
    );
    // Beyond the window that temporary storage is guaranteed to outlive.
    assert_eq!(
        f.client.try_make_offer(
            &m1,
            &f.funder_a,
            &PRINCIPAL,
            &REPAYMENT_A,
            &(f.now() + MAX_OFFER_VALIDITY_SECONDS + 1)
        ),
        Err(Ok(Error::InvalidExpiry)),
    );
}

#[test]
fn make_offer_enforces_the_per_milestone_offer_limit() {
    let f = setup();
    let (_, m1, _) = f.milestone_seeking_finance();
    let expires = f.now() + OFFER_TTL;

    for _ in 0..MAX_OFFERS_PER_MILESTONE {
        f.client
            .make_offer(&m1, &f.funder_a, &PRINCIPAL, &REPAYMENT_A, &expires);
    }

    assert_eq!(
        f.client
            .try_make_offer(&m1, &f.funder_b, &PRINCIPAL, &REPAYMENT_B, &expires),
        Err(Ok(Error::OfferLimitReached)),
    );
}

#[test]
fn cancel_offer_withdraws_an_open_offer() {
    let f = setup();
    let (_, m1, _) = f.milestone_seeking_finance();
    let (offer_a, _) = f.competing_offers(m1);

    f.client.cancel_offer(&offer_a);

    assert_eq!(f.client.get_offer(&offer_a).status, OfferStatus::Cancelled);
    // A cancelled offer is no longer selectable.
    let open = f.client.get_open_offers(&m1);
    assert_eq!(open.len(), 1);
    assert_eq!(open.get(0).unwrap().funder, f.funder_b);
}

#[test]
fn cancel_offer_requires_the_offers_own_funder() {
    let f = setup();
    let (_, m1, _) = f.milestone_seeking_finance();
    let (offer_a, _) = f.competing_offers(m1);

    f.env.mock_auths(&[MockAuth {
        address: &f.funder_b,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "cancel_offer",
            args: (offer_a,).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);

    assert!(
        f.client.try_cancel_offer(&offer_a).is_err(),
        "a rival funder must not be able to withdraw someone else's offer"
    );
}

#[test]
fn a_cancelled_offer_cannot_be_accepted() {
    let f = setup();
    let (_, m1, _) = f.milestone_seeking_finance();
    let (offer_a, _) = f.competing_offers(m1);
    f.client.cancel_offer(&offer_a);

    assert_eq!(
        f.client.try_accept_offer(&offer_a),
        Err(Ok(Error::InvalidOfferStatus)),
    );
}

#[test]
fn get_open_offers_hides_expired_offers() {
    let f = setup();
    let (_, m1, _) = f.milestone_seeking_finance();
    f.competing_offers(m1);
    assert_eq!(f.client.get_open_offers(&m1).len(), 2);

    f.advance_time(OFFER_TTL + 1);

    // The index still names them, but none is selectable.
    assert_eq!(f.client.get_milestone_offer_ids(&m1).len(), 2);
    assert!(f.client.get_open_offers(&m1).is_empty());
}

#[test]
fn a_stale_offer_index_cannot_present_a_vanished_offer() {
    let f = setup();
    let (_, m1, _) = f.milestone_seeking_finance();
    let (offer_a, _) = f.competing_offers(m1);

    // Outlive temporary storage entirely.
    f.env
        .ledger()
        .set_sequence_number(f.env.ledger().sequence() + TEMPORARY_BUMP_AMOUNT + 1);

    // No financial decision may be made from the index: resolving an id that
    // no longer exists simply drops it.
    assert!(f.client.get_open_offers(&m1).is_empty());
    assert_eq!(
        f.client.try_get_offer(&offer_a),
        Err(Ok(Error::OfferNotFound))
    );
    assert_eq!(
        f.client.try_accept_offer(&offer_a),
        Err(Ok(Error::OfferNotFound)),
    );
}

// ===========================================================================
// PKG-03 — Accepting an offer
// ===========================================================================

#[test]
fn accept_offer_freezes_the_selected_economics() {
    let f = setup();
    let (_, m1, _) = f.milestone_seeking_finance();
    let (_, offer_b) = f.competing_offers(m1);

    f.client.accept_offer(&offer_b);

    let accepted = f.client.get_accepted_offer(&m1);
    assert_eq!(accepted.id, offer_b);
    assert_eq!(accepted.funder, f.funder_b);
    assert_eq!(accepted.principal, PRINCIPAL);
    assert_eq!(accepted.repayment, REPAYMENT_B);
    assert_eq!(accepted.status, OfferStatus::Accepted);
    assert_eq!(
        f.client.get_finance_request(&m1).status,
        FinanceRequestStatus::Accepted
    );
    // Still no money has moved.
    assert_eq!(f.balance(&f.supplier), 0);
    assert_eq!(f.balance(&f.funder_b), FUNDER_INITIAL_BALANCE);
}

#[test]
fn an_expired_offer_cannot_be_accepted() {
    let f = setup();
    let (_, m1, _) = f.milestone_seeking_finance();
    let (_, offer_b) = f.competing_offers(m1);

    f.advance_time(OFFER_TTL + 1);

    assert_eq!(
        f.client.try_accept_offer(&offer_b),
        Err(Ok(Error::OfferExpired)),
    );
    assert_eq!(
        f.client.try_get_accepted_offer(&m1),
        Err(Ok(Error::NoAcceptedOffer)),
    );
}

#[test]
fn the_supplier_cannot_replace_an_accepted_offer() {
    let f = setup();
    let (_, m1, _) = f.milestone_seeking_finance();
    let (offer_a, offer_b) = f.competing_offers(m1);
    f.client.accept_offer(&offer_b);

    // Switching to the rival offer after selection is rejected.
    assert_eq!(
        f.client.try_accept_offer(&offer_a),
        Err(Ok(Error::InvalidFinanceRequestStatus)),
    );
    // Re-accepting the same one is rejected too.
    assert_eq!(
        f.client.try_accept_offer(&offer_b),
        Err(Ok(Error::InvalidFinanceRequestStatus)),
    );
    // The frozen economics are unchanged.
    assert_eq!(f.client.get_accepted_offer(&m1).repayment, REPAYMENT_B);
}

#[test]
fn accept_offer_requires_the_supplier() {
    let f = setup();
    let (_, m1, _) = f.milestone_seeking_finance();
    let (_, offer_b) = f.competing_offers(m1);

    for impostor in [f.buyer.clone(), f.funder_b.clone()] {
        f.env.mock_auths(&[MockAuth {
            address: &impostor,
            invoke: &MockAuthInvoke {
                contract: &f.contract_id,
                fn_name: "accept_offer",
                args: (offer_b,).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        assert!(
            f.client.try_accept_offer(&offer_b).is_err(),
            "only the supplier may select the winning offer"
        );
    }
}

#[test]
fn no_new_offer_can_be_made_after_selection() {
    let f = setup();
    let (_, m1, _) = f.milestone_seeking_finance();
    let (_, offer_b) = f.competing_offers(m1);
    f.client.accept_offer(&offer_b);

    // The request is closed, so accepted economics cannot be undercut.
    assert_eq!(
        f.client.try_make_offer(
            &m1,
            &f.funder_a,
            &PRINCIPAL,
            &(REPAYMENT_B - 1),
            &(f.now() + OFFER_TTL)
        ),
        Err(Ok(Error::InvalidFinanceRequestStatus)),
    );
}

#[test]
fn an_accepted_offer_cannot_be_cancelled_by_its_funder() {
    let f = setup();
    let (_, m1, _) = f.milestone_seeking_finance();
    let (_, offer_b) = f.competing_offers(m1);
    f.client.accept_offer(&offer_b);

    assert_eq!(
        f.client.try_cancel_offer(&offer_b),
        Err(Ok(Error::InvalidOfferStatus)),
    );
}

// ===========================================================================
// PKG-03 — The funder advance
//
// The core economic claim of Milvance is tested here: the supplier's early
// liquidity comes from FUNDER capital, and buyer escrow is never its source.
// ===========================================================================

#[test]
fn fund_advance_moves_funder_capital_to_the_supplier() {
    let f = setup();
    let (_, m1, _) = f.milestone_seeking_finance();
    let (_, offer_b) = f.competing_offers(m1);
    f.client.accept_offer(&offer_b);

    f.client.fund_advance(&m1);

    // Exact funder decrease.
    assert_eq!(
        f.balance(&f.funder_b),
        FUNDER_INITIAL_BALANCE - PRINCIPAL,
        "the advance leaves the funder's own wallet"
    );
    // Exact supplier increase.
    assert_eq!(
        f.balance(&f.supplier),
        PRINCIPAL,
        "the supplier receives spendable liquidity now"
    );
    // The losing funder is untouched.
    assert_eq!(f.balance(&f.funder_a), FUNDER_INITIAL_BALANCE);
}

#[test]
fn buyer_escrow_is_untouched_by_the_advance() {
    let f = setup();
    let (_, m1, _) = f.milestone_seeking_finance();
    let (_, offer_b) = f.competing_offers(m1);
    f.client.accept_offer(&offer_b);

    let escrow_before = f.escrow_balance();
    let protected_before = f.client.get_milestone(&m1).funded_amount;
    let buyer_before = f.balance(&f.buyer);

    f.client.fund_advance(&m1);

    // Contract-held custody is byte-for-byte identical.
    assert_eq!(f.escrow_balance(), escrow_before);
    assert_eq!(f.escrow_balance(), AMOUNT_M1);
    // The milestone's protected accounting is unchanged.
    assert_eq!(f.client.get_milestone(&m1).funded_amount, protected_before);
    // And the buyer paid nothing further.
    assert_eq!(f.balance(&f.buyer), buyer_before);
}

#[test]
fn the_advance_is_not_drawn_from_buyer_escrow() {
    let f = setup();
    let (_, m1, _) = f.milestone_seeking_finance();
    let (_, offer_b) = f.competing_offers(m1);
    f.client.accept_offer(&offer_b);

    let contract_before = f.escrow_balance();
    let funder_before = f.balance(&f.funder_b);

    f.client.fund_advance(&m1);

    // Every unit the supplier gained came out of the funder, and none out of
    // the contract: the two money flows are provably separate.
    let supplier_gain = f.balance(&f.supplier);
    let funder_loss = funder_before - f.balance(&f.funder_b);
    let contract_change = f.escrow_balance() - contract_before;

    assert_eq!(supplier_gain, PRINCIPAL);
    assert_eq!(funder_loss, PRINCIPAL);
    assert_eq!(contract_change, 0);
}

#[test]
fn fund_advance_persists_the_finance_position() {
    let f = setup();
    let (_, m1, _) = f.milestone_seeking_finance();
    let (_, offer_b) = f.competing_offers(m1);
    f.client.accept_offer(&offer_b);

    f.client.fund_advance(&m1);

    let position = f.client.get_finance_position(&m1);
    assert_eq!(position.milestone_id, m1);
    assert_eq!(position.offer_id, offer_b);
    assert_eq!(position.funder, f.funder_b);
    assert_eq!(position.supplier, f.supplier);
    assert_eq!(position.principal, PRINCIPAL);
    assert_eq!(position.repayment, REPAYMENT_B);
    assert_eq!(position.status, FinancePositionStatus::Active);
    assert!(f.client.has_active_finance_position(&m1));

    assert_eq!(
        f.client.get_milestone(&m1).status,
        MilestoneStatus::Financed
    );
    assert_eq!(f.client.get_accepted_offer(&m1).status, OfferStatus::Funded);
}

#[test]
fn the_canonical_example_reconciles_exactly() {
    let f = setup();
    let (_, m1, _) = f.milestone_seeking_finance();
    let (_, offer_b) = f.competing_offers(m1);
    f.client.accept_offer(&offer_b);
    f.client.fund_advance(&m1);

    // AGENT.md §9: 2,000 protected, 1,400 advanced, 1,445 owed to the funder,
    // leaving 555 as the supplier's remainder at settlement (PKG-04).
    let milestone = f.client.get_milestone(&m1);
    let position = f.client.get_finance_position(&m1);
    assert_eq!(milestone.funded_amount, 2_000 * STROOPS_PER_UNIT);
    assert_eq!(position.principal, 1_400 * STROOPS_PER_UNIT);
    assert_eq!(position.repayment, 1_445 * STROOPS_PER_UNIT);
    assert_eq!(
        milestone.funded_amount - position.repayment,
        555 * STROOPS_PER_UNIT
    );
    // Repayment can never exceed what the milestone holds.
    assert!(position.repayment <= milestone.funded_amount);
}

// ---------------------------------------------------------------------------
// Duplicate financing and funder races
// ---------------------------------------------------------------------------

#[test]
fn only_one_finance_position_can_ever_become_active() {
    let f = setup();
    let (_, m1, _) = f.milestone_seeking_finance();
    let (_, offer_b) = f.competing_offers(m1);
    f.client.accept_offer(&offer_b);
    f.client.fund_advance(&m1);

    // A second advance on the same milestone is rejected (invariant 1).
    assert_eq!(
        f.client.try_fund_advance(&m1),
        Err(Ok(Error::AlreadyFinanced))
    );

    // And the supplier was paid exactly once.
    assert_eq!(f.balance(&f.supplier), PRINCIPAL);
    assert_eq!(f.balance(&f.funder_b), FUNDER_INITIAL_BALANCE - PRINCIPAL);
    assert_eq!(f.client.get_finance_position(&m1).principal, PRINCIPAL);
}

#[test]
fn the_losing_funder_in_a_race_cannot_create_a_second_position() {
    let f = setup();
    let (_, m1, _) = f.milestone_seeking_finance();
    let (_, offer_b) = f.competing_offers(m1);
    // Both funders want this milestone; the supplier selects B.
    f.client.accept_offer(&offer_b);

    // Funder A races to fund first, authorizing only itself.
    f.env.mock_auths(&[MockAuth {
        address: &f.funder_a,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "fund_advance",
            args: (m1,).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(
        f.client.try_fund_advance(&m1).is_err(),
        "a funder whose offer was not selected cannot fund"
    );
    assert_eq!(f.balance(&f.funder_a), FUNDER_INITIAL_BALANCE);
    assert_eq!(f.balance(&f.supplier), 0);

    // B then funds normally.
    f.env.mock_all_auths();
    f.client.fund_advance(&m1);

    // A races again after the fact and is rejected by the position guard.
    assert_eq!(
        f.client.try_fund_advance(&m1),
        Err(Ok(Error::AlreadyFinanced))
    );
    assert_eq!(f.client.get_finance_position(&m1).funder, f.funder_b);
    assert_eq!(f.balance(&f.funder_a), FUNDER_INITIAL_BALANCE);
}

#[test]
fn a_second_finance_request_after_funding_is_rejected() {
    let f = setup();
    let (_, m1, _) = f.milestone_seeking_finance();
    let (_, offer_b) = f.competing_offers(m1);
    f.client.accept_offer(&offer_b);
    f.client.fund_advance(&m1);

    // The milestone is Financed, so it cannot re-enter the financing flow.
    assert_eq!(
        f.client
            .try_request_finance(&m1, &PRINCIPAL, &(f.now() + REQUEST_TTL)),
        Err(Ok(Error::InvalidMilestoneStatus)),
    );
}

// ---------------------------------------------------------------------------
// fund_advance guards
// ---------------------------------------------------------------------------

#[test]
fn fund_advance_requires_an_accepted_offer() {
    let f = setup();
    let (_, m1, _) = f.milestone_seeking_finance();
    f.competing_offers(m1);

    // Offers exist, but the supplier has selected none.
    assert_eq!(
        f.client.try_fund_advance(&m1),
        Err(Ok(Error::NoAcceptedOffer))
    );
    assert_eq!(f.balance(&f.supplier), 0);
}

#[test]
fn the_wrong_funder_cannot_fund_an_accepted_offer() {
    let f = setup();
    let (_, m1, _) = f.milestone_seeking_finance();
    let (_, offer_b) = f.competing_offers(m1);
    f.client.accept_offer(&offer_b);

    for impostor in [f.funder_a.clone(), f.buyer.clone(), f.outsider.clone()] {
        f.env.mock_auths(&[MockAuth {
            address: &impostor,
            invoke: &MockAuthInvoke {
                contract: &f.contract_id,
                fn_name: "fund_advance",
                args: (m1,).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        assert!(
            f.client.try_fund_advance(&m1).is_err(),
            "only the selected funder may fund the advance"
        );
    }

    assert_eq!(f.balance(&f.supplier), 0);
    assert_eq!(f.escrow_balance(), AMOUNT_M1);
}

#[test]
fn an_expired_accepted_offer_cannot_be_funded() {
    let f = setup();
    let (_, m1, _) = f.milestone_seeking_finance();
    let (_, offer_b) = f.competing_offers(m1);
    f.client.accept_offer(&offer_b);

    // The funder sat on the accepted offer until it expired.
    f.advance_time(OFFER_TTL + 1);

    assert_eq!(f.client.try_fund_advance(&m1), Err(Ok(Error::OfferExpired)));
    assert_eq!(f.balance(&f.supplier), 0);
    assert_eq!(f.balance(&f.funder_b), FUNDER_INITIAL_BALANCE);
    assert!(!f.client.has_active_finance_position(&m1));
}

#[test]
fn fund_advance_rejects_an_unknown_milestone() {
    let f = setup();
    assert_eq!(
        f.client.try_fund_advance(&999),
        Err(Ok(Error::MilestoneNotFound)),
    );
}

#[test]
fn a_rejected_advance_moves_no_money_and_emits_nothing() {
    let f = setup();
    let (_, m1, _) = f.milestone_seeking_finance();
    f.competing_offers(m1);

    let _ = f.client.try_fund_advance(&m1);

    assert_eq!(f.event_count(), 0);
    assert_eq!(f.balance(&f.supplier), 0);
    assert_eq!(f.balance(&f.funder_a), FUNDER_INITIAL_BALANCE);
    assert_eq!(f.balance(&f.funder_b), FUNDER_INITIAL_BALANCE);
    assert_eq!(f.escrow_balance(), AMOUNT_M1);
}

// ---------------------------------------------------------------------------
// Durability of funded economics
// ---------------------------------------------------------------------------

#[test]
fn temporary_offer_expiry_does_not_disturb_a_funded_position() {
    let f = setup();
    let (_, m1, _) = f.milestone_seeking_finance();
    let (_, offer_b) = f.competing_offers(m1);
    f.client.accept_offer(&offer_b);
    f.client.fund_advance(&m1);

    // Outlive temporary storage entirely.
    f.env
        .ledger()
        .set_sequence_number(f.env.ledger().sequence() + TEMPORARY_BUMP_AMOUNT + 1);

    // The temporary offer entry is gone...
    assert_eq!(
        f.client.try_get_offer(&offer_b),
        Err(Ok(Error::OfferNotFound))
    );

    // ...but the economics the funder is owed survive untouched, because they
    // were copied into persistent storage at acceptance.
    let position = f.client.get_finance_position(&m1);
    assert_eq!(position.principal, PRINCIPAL);
    assert_eq!(position.repayment, REPAYMENT_B);
    assert_eq!(position.funder, f.funder_b);
    assert_eq!(position.status, FinancePositionStatus::Active);
    assert_eq!(f.client.get_accepted_offer(&m1).repayment, REPAYMENT_B);
    assert_eq!(
        f.client.get_milestone(&m1).status,
        MilestoneStatus::Financed
    );
    assert_eq!(f.escrow_balance(), AMOUNT_M1);
}

#[test]
fn offers_receive_a_temporary_ttl_that_outlives_their_validity() {
    let f = setup();
    let (_, m1, _) = f.milestone_seeking_finance();
    let (offer_a, _) = f.competing_offers(m1);

    // Storage must outlive business expiry, so an offer dies by an explicit
    // timestamp check rather than by vanishing.
    assert_eq!(f.offer_ttl(offer_a), TEMPORARY_BUMP_AMOUNT);
    let max_validity_in_ledgers = (MAX_OFFER_VALIDITY_SECONDS / 5) as u32;
    assert!(TEMPORARY_BUMP_AMOUNT > max_validity_in_ledgers);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[test]
fn financing_emits_its_events() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();
    f.client.fund_milestone(&m1, &AMOUNT_M1, &f.usdc);

    f.client
        .request_finance(&m1, &PRINCIPAL, &(f.now() + REQUEST_TTL));
    assert_eq!(
        f.last_event_name(),
        Symbol::new(&f.env, "finance_requested")
    );

    let offer_id = f.client.make_offer(
        &m1,
        &f.funder_b,
        &PRINCIPAL,
        &REPAYMENT_B,
        &(f.now() + OFFER_TTL),
    );
    assert_eq!(
        f.last_event_name(),
        Symbol::new(&f.env, "funding_offer_created")
    );

    let cancelled = f.client.make_offer(
        &m1,
        &f.funder_a,
        &PRINCIPAL,
        &REPAYMENT_A,
        &(f.now() + OFFER_TTL),
    );
    f.client.cancel_offer(&cancelled);
    assert_eq!(
        f.last_event_name(),
        Symbol::new(&f.env, "funding_offer_cancelled")
    );

    f.client.accept_offer(&offer_id);
    assert_eq!(f.last_event_name(), Symbol::new(&f.env, "offer_accepted"));

    f.client.fund_advance(&m1);
    assert_eq!(f.last_event_name(), Symbol::new(&f.env, "advance_funded"));
}

// ---------------------------------------------------------------------------
// Milestone isolation under financing
// ---------------------------------------------------------------------------

#[test]
fn financing_one_milestone_leaves_the_others_alone() {
    let f = setup();
    let (_, m1, m2) = f.milestone_seeking_finance();
    f.client.fund_milestone(&m2, &AMOUNT_M2, &f.usdc);
    let (_, offer_b) = f.competing_offers(m1);
    f.client.accept_offer(&offer_b);

    f.client.fund_advance(&m1);

    // M2 has its own protected escrow and no financing state whatsoever.
    let m2_state = f.client.get_milestone(&m2);
    assert_eq!(m2_state.status, MilestoneStatus::Funded);
    assert_eq!(m2_state.funded_amount, AMOUNT_M2);
    assert!(!f.client.has_active_finance_position(&m2));
    assert_eq!(
        f.client.try_get_finance_position(&m2),
        Err(Ok(Error::FinancePositionNotFound)),
    );
    // Both milestones' escrow is still fully in the contract.
    assert_eq!(f.escrow_balance(), AMOUNT_M1 + AMOUNT_M2);
}

// ===========================================================================
// PKG-03 hardening — liveness recovery from an unfunded acceptance
//
// A selected funder is not obliged to advance. These tests prove the supplier
// can always recover, and that the recovery cannot be abused to unwind real
// financing or move value.
// ===========================================================================

/// Selects funder B's offer and lets it lapse without an advance.
fn accepted_but_never_funded(f: &Fixture) -> (u64, u64, u64) {
    let (order_id, m1, m2) = f.milestone_seeking_finance();
    let (_, offer_b) = f.competing_offers(m1);
    f.client.accept_offer(&offer_b);
    (order_id, m1, m2)
}

#[test]
fn a_live_acceptance_cannot_be_released() {
    let f = setup();
    let (_, m1, _) = accepted_but_never_funded(&f);

    // The selected funder still has time to fund.
    assert_eq!(
        f.client.try_release_expired_acceptance(&m1),
        Err(Ok(Error::OfferStillLive)),
    );
    assert_eq!(f.client.get_accepted_offer(&m1).repayment, REPAYMENT_B);
}

#[test]
fn the_supplier_can_recover_from_an_expired_acceptance() {
    let f = setup();
    let (_, m1, _) = accepted_but_never_funded(&f);

    f.advance_time(OFFER_TTL + 1);
    let request_reopened = f.client.release_expired_acceptance(&m1);

    // The finance request still had time left, so it is usable again.
    assert!(request_reopened);
    assert_eq!(
        f.client.get_finance_request(&m1).status,
        FinanceRequestStatus::Open
    );
    assert_eq!(
        f.client.get_milestone(&m1).status,
        MilestoneStatus::FinanceRequested
    );
    assert_eq!(
        f.client.try_get_accepted_offer(&m1),
        Err(Ok(Error::NoAcceptedOffer)),
    );
}

#[test]
fn recovery_moves_no_tokens_and_leaves_buyer_escrow_unchanged() {
    let f = setup();
    let (_, m1, _) = accepted_but_never_funded(&f);
    f.advance_time(OFFER_TTL + 1);

    let escrow_before = f.escrow_balance();
    let protected_before = f.client.get_milestone(&m1).funded_amount;

    f.client.release_expired_acceptance(&m1);

    // Nothing moved anywhere: an acceptance is a selection, not a transfer.
    assert_eq!(f.escrow_balance(), escrow_before);
    assert_eq!(f.escrow_balance(), AMOUNT_M1);
    assert_eq!(f.client.get_milestone(&m1).funded_amount, protected_before);
    assert_eq!(f.balance(&f.supplier), 0);
    assert_eq!(f.balance(&f.funder_a), FUNDER_INITIAL_BALANCE);
    assert_eq!(f.balance(&f.funder_b), FUNDER_INITIAL_BALANCE);
    assert_eq!(f.balance(&f.buyer), BUYER_INITIAL_BALANCE - AMOUNT_M1);
}

#[test]
fn only_the_supplier_may_release_an_expired_acceptance() {
    let f = setup();
    let (_, m1, _) = accepted_but_never_funded(&f);
    f.advance_time(OFFER_TTL + 1);

    for impostor in [
        f.outsider.clone(),
        f.buyer.clone(),
        f.funder_a.clone(),
        f.funder_b.clone(),
    ] {
        f.env.mock_auths(&[MockAuth {
            address: &impostor,
            invoke: &MockAuthInvoke {
                contract: &f.contract_id,
                fn_name: "release_expired_acceptance",
                args: (m1,).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        assert!(
            f.client.try_release_expired_acceptance(&m1).is_err(),
            "only the supplier may release their own stalled acceptance"
        );
    }

    // The acceptance survived every attempt.
    f.env.mock_all_auths();
    assert_eq!(f.client.get_accepted_offer(&m1).funder, f.funder_b);
}

#[test]
fn the_lapsed_funder_cannot_fund_after_recovery() {
    let f = setup();
    let (_, m1, _) = accepted_but_never_funded(&f);
    f.advance_time(OFFER_TTL + 1);
    f.client.release_expired_acceptance(&m1);

    // The selection is gone, so the funder that let it lapse has nothing to fund.
    assert_eq!(
        f.client.try_fund_advance(&m1),
        Err(Ok(Error::NoAcceptedOffer))
    );
    assert_eq!(f.balance(&f.supplier), 0);
    assert_eq!(f.balance(&f.funder_b), FUNDER_INITIAL_BALANCE);
    assert!(!f.client.has_active_finance_position(&m1));
}

#[test]
fn a_funded_position_can_never_be_cleared_through_recovery() {
    let f = setup();
    let (_, m1, _) = accepted_but_never_funded(&f);
    f.client.fund_advance(&m1);

    // Even once the offer's expiry has passed, real financing is untouchable.
    f.advance_time(OFFER_TTL + 1);
    assert_eq!(
        f.client.try_release_expired_acceptance(&m1),
        Err(Ok(Error::AlreadyFinanced)),
    );

    // The position and the advance are intact.
    let position = f.client.get_finance_position(&m1);
    assert_eq!(position.status, FinancePositionStatus::Active);
    assert_eq!(position.repayment, REPAYMENT_B);
    assert_eq!(f.balance(&f.supplier), PRINCIPAL);
    assert_eq!(
        f.client.get_milestone(&m1).status,
        MilestoneStatus::Financed
    );
    assert_eq!(f.escrow_balance(), AMOUNT_M1);
}

#[test]
fn a_live_request_continues_normally_after_recovery() {
    let f = setup();
    let (_, m1, _) = accepted_but_never_funded(&f);
    f.advance_time(OFFER_TTL + 1);
    assert!(f.client.release_expired_acceptance(&m1));

    // The supplier can take a fresh offer from a different funder and be funded.
    let offer = f.client.make_offer(
        &m1,
        &f.funder_a,
        &PRINCIPAL,
        &REPAYMENT_A,
        &(f.now() + OFFER_TTL),
    );
    f.client.accept_offer(&offer);
    f.client.fund_advance(&m1);

    let position = f.client.get_finance_position(&m1);
    assert_eq!(position.funder, f.funder_a);
    assert_eq!(position.repayment, REPAYMENT_A);
    assert_eq!(f.balance(&f.supplier), PRINCIPAL);
    assert_eq!(f.balance(&f.funder_a), FUNDER_INITIAL_BALANCE - PRINCIPAL);
    // The funder that lapsed paid nothing.
    assert_eq!(f.balance(&f.funder_b), FUNDER_INITIAL_BALANCE);
    assert_eq!(f.escrow_balance(), AMOUNT_M1);
}

#[test]
fn an_expired_request_returns_the_milestone_to_funded() {
    let f = setup();
    let (_, m1, _) = accepted_but_never_funded(&f);

    // Both the acceptance and the request lapse.
    f.advance_time(REQUEST_TTL + 1);
    let request_reopened = f.client.release_expired_acceptance(&m1);

    assert!(!request_reopened);
    assert_eq!(
        f.client.get_finance_request(&m1).status,
        FinanceRequestStatus::Cancelled
    );
    // Back to a protected, financeable milestone — no new state was invented.
    assert_eq!(f.client.get_milestone(&m1).status, MilestoneStatus::Funded);
    assert!(f.client.is_fully_funded(&m1));
    assert_eq!(f.escrow_balance(), AMOUNT_M1);
}

#[test]
fn the_supplier_can_request_financing_again_after_recovery() {
    let f = setup();
    let (_, m1, _) = accepted_but_never_funded(&f);
    f.advance_time(REQUEST_TTL + 1);
    f.client.release_expired_acceptance(&m1);

    // A completely fresh financing round on the same protected milestone.
    let expires = f.now() + REQUEST_TTL;
    f.client.request_finance(&m1, &PRINCIPAL, &expires);

    let request = f.client.get_finance_request(&m1);
    assert_eq!(request.status, FinanceRequestStatus::Open);
    assert_eq!(request.expires_at, expires);
    assert_eq!(
        f.client.get_milestone(&m1).status,
        MilestoneStatus::FinanceRequested
    );
    // The stale round's offers do not carry over.
    assert!(f.client.get_open_offers(&m1).is_empty());

    let offer = f.client.make_offer(
        &m1,
        &f.funder_a,
        &PRINCIPAL,
        &REPAYMENT_A,
        &(f.now() + OFFER_TTL),
    );
    f.client.accept_offer(&offer);
    f.client.fund_advance(&m1);
    assert_eq!(f.balance(&f.supplier), PRINCIPAL);
}

#[test]
fn recovery_cannot_produce_a_duplicate_finance_position() {
    let f = setup();
    let (_, m1, _) = accepted_but_never_funded(&f);
    f.advance_time(OFFER_TTL + 1);
    f.client.release_expired_acceptance(&m1);

    let offer = f.client.make_offer(
        &m1,
        &f.funder_a,
        &PRINCIPAL,
        &REPAYMENT_A,
        &(f.now() + OFFER_TTL),
    );
    f.client.accept_offer(&offer);
    f.client.fund_advance(&m1);

    // Still exactly one position, and no second advance is possible.
    assert_eq!(
        f.client.try_fund_advance(&m1),
        Err(Ok(Error::AlreadyFinanced))
    );
    // Nor can recovery be replayed to open a second round.
    assert_eq!(
        f.client.try_release_expired_acceptance(&m1),
        Err(Ok(Error::AlreadyFinanced)),
    );
    assert_eq!(f.balance(&f.supplier), PRINCIPAL);
    assert_eq!(f.client.get_finance_position(&m1).funder, f.funder_a);
}

#[test]
fn recovery_requires_an_accepted_offer() {
    let f = setup();
    let (_, m1, _) = f.milestone_seeking_finance();
    f.competing_offers(m1);
    f.advance_time(OFFER_TTL + 1);

    // Offers expired, but the supplier never selected one: nothing to release.
    assert_eq!(
        f.client.try_release_expired_acceptance(&m1),
        Err(Ok(Error::NoAcceptedOffer)),
    );
}

#[test]
fn the_released_offer_cannot_be_reselected() {
    let f = setup();
    let (_, m1, _) = accepted_but_never_funded(&f);
    let released_offer = f.client.get_accepted_offer(&m1).id;
    f.advance_time(OFFER_TTL + 1);
    f.client.release_expired_acceptance(&m1);

    assert_eq!(
        f.client.get_offer(&released_offer).status,
        OfferStatus::Cancelled
    );
    assert!(f.client.get_open_offers(&m1).is_empty());
    assert_eq!(
        f.client.try_accept_offer(&released_offer),
        Err(Ok(Error::InvalidOfferStatus)),
    );
}

#[test]
fn recovery_emits_acceptance_released() {
    let f = setup();
    let (_, m1, _) = accepted_but_never_funded(&f);
    f.advance_time(OFFER_TTL + 1);

    f.client.release_expired_acceptance(&m1);

    assert_eq!(
        f.last_event_name(),
        Symbol::new(&f.env, "acceptance_released")
    );
}

// ===========================================================================
// PKG-04 — Evidence and attestation
// ===========================================================================

#[test]
fn the_supplier_commits_an_evidence_digest() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();
    f.client.fund_milestone(&m1, &AMOUNT_M1, &f.usdc);

    let hash = f.evidence(1);
    f.client.submit_evidence(&m1, &hash);

    let milestone = f.client.get_milestone(&m1);
    assert_eq!(milestone.status, MilestoneStatus::Submitted);
    assert_eq!(milestone.evidence_hash, Some(hash.clone()));
    assert_eq!(f.client.get_evidence_hash(&m1), hash);
    // Committing evidence moves no money.
    assert_eq!(f.escrow_balance(), AMOUNT_M1);
    assert_eq!(f.balance(&f.supplier), 0);
}

#[test]
fn a_financed_milestone_can_submit_evidence() {
    let f = setup();
    let (_, m1, _) = f.milestone_seeking_finance();
    let (_, offer_b) = f.competing_offers(m1);
    f.client.accept_offer(&offer_b);
    f.client.fund_advance(&m1);

    f.client.submit_evidence(&m1, &f.evidence(1));

    assert_eq!(
        f.client.get_milestone(&m1).status,
        MilestoneStatus::Submitted
    );
    // The advance the supplier already received is untouched.
    assert_eq!(f.balance(&f.supplier), PRINCIPAL);
}

#[test]
fn evidence_may_be_corrected_before_verification() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();
    f.client.fund_milestone(&m1, &AMOUNT_M1, &f.usdc);

    f.client.submit_evidence(&m1, &f.evidence(1));
    let corrected = f.evidence(2);
    f.client.submit_evidence(&m1, &corrected);

    assert_eq!(f.client.get_evidence_hash(&m1), corrected);
}

#[test]
fn evidence_cannot_be_overwritten_after_verification() {
    let f = setup();
    let (_, m1, _) = f.unfinanced_and_verified();
    let verified_hash = f.client.get_evidence_hash(&m1);

    assert_eq!(
        f.client.try_submit_evidence(&m1, &f.evidence(9)),
        Err(Ok(Error::InvalidMilestoneStatus)),
    );
    assert_eq!(f.client.get_evidence_hash(&m1), verified_hash);
}

#[test]
fn evidence_is_frozen_once_the_milestone_is_terminal() {
    let f = setup();
    let (_, m1, _) = f.unfinanced_and_verified();
    let hash = f.client.get_evidence_hash(&m1);
    f.client.settle_milestone(&m1, &f.supplier);

    assert_eq!(
        f.client.try_submit_evidence(&m1, &f.evidence(9)),
        Err(Ok(Error::InvalidMilestoneStatus)),
    );
    assert_eq!(f.client.get_evidence_hash(&m1), hash);
}

#[test]
fn an_all_zero_digest_is_rejected() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();
    f.client.fund_milestone(&m1, &AMOUNT_M1, &f.usdc);

    let zero = BytesN::from_array(&f.env, &[0u8; 32]);
    assert_eq!(
        f.client.try_submit_evidence(&m1, &zero),
        Err(Ok(Error::InvalidEvidence)),
    );
}

#[test]
fn evidence_requires_a_protected_milestone() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();

    // Unfunded: there is nothing protected to verify against.
    assert_eq!(
        f.client.try_submit_evidence(&m1, &f.evidence(1)),
        Err(Ok(Error::InvalidMilestoneStatus)),
    );
}

#[test]
fn only_the_supplier_may_submit_evidence() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();
    f.client.fund_milestone(&m1, &AMOUNT_M1, &f.usdc);
    let hash = f.evidence(1);

    for impostor in [f.buyer.clone(), f.attestor.clone(), f.outsider.clone()] {
        f.env.mock_auths(&[MockAuth {
            address: &impostor,
            invoke: &MockAuthInvoke {
                contract: &f.contract_id,
                fn_name: "submit_evidence",
                args: (m1, hash.clone()).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        assert!(
            f.client.try_submit_evidence(&m1, &hash).is_err(),
            "only the supplier may commit evidence"
        );
    }
}

#[test]
fn the_assigned_attestor_verifies_the_milestone() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();
    f.client.fund_milestone(&m1, &AMOUNT_M1, &f.usdc);
    let hash = f.evidence(1);
    f.client.submit_evidence(&m1, &hash);

    f.client.attest_milestone(&m1, &hash);

    assert_eq!(
        f.client.get_milestone(&m1).status,
        MilestoneStatus::Verified
    );
    // Verification moves no money on its own.
    assert_eq!(f.escrow_balance(), AMOUNT_M1);
    assert_eq!(f.balance(&f.supplier), 0);
}

#[test]
fn the_wrong_attestor_cannot_verify() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();
    f.client.fund_milestone(&m1, &AMOUNT_M1, &f.usdc);
    let hash = f.evidence(1);
    f.client.submit_evidence(&m1, &hash);

    for impostor in [
        f.buyer.clone(),
        f.supplier.clone(),
        f.resolver.clone(),
        f.outsider.clone(),
    ] {
        f.env.mock_auths(&[MockAuth {
            address: &impostor,
            invoke: &MockAuthInvoke {
                contract: &f.contract_id,
                fn_name: "attest_milestone",
                args: (m1, hash.clone()).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        assert!(
            f.client.try_attest_milestone(&m1, &hash).is_err(),
            "only the assigned attestor may verify"
        );
    }

    f.env.mock_all_auths();
    assert_eq!(
        f.client.get_milestone(&m1).status,
        MilestoneStatus::Submitted
    );
}

#[test]
fn the_attestor_must_sign_for_the_digest_on_record() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();
    f.client.fund_milestone(&m1, &AMOUNT_M1, &f.usdc);
    f.client.submit_evidence(&m1, &f.evidence(1));

    // Guards against a supplier swapping evidence between the attestor
    // reviewing it off-chain and their transaction landing.
    assert_eq!(
        f.client.try_attest_milestone(&m1, &f.evidence(2)),
        Err(Ok(Error::EvidenceMismatch)),
    );
    assert_eq!(
        f.client.get_milestone(&m1).status,
        MilestoneStatus::Submitted
    );
}

#[test]
fn verification_requires_submitted_evidence() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();
    f.client.fund_milestone(&m1, &AMOUNT_M1, &f.usdc);

    assert_eq!(
        f.client.try_attest_milestone(&m1, &f.evidence(1)),
        Err(Ok(Error::InvalidMilestoneStatus)),
    );
}

// ===========================================================================
// PKG-04 — Settlement
// ===========================================================================

#[test]
fn financed_settlement_pays_the_funder_first_then_the_supplier() {
    let f = setup();
    let (_, m1, _) = f.financed_and_verified();

    let funder_before = f.balance(&f.funder_b);
    f.client.settle_milestone(&m1, &f.supplier);

    // AGENT.md §9.4: 2,000 protected -> 1,445 funder, 555 supplier.
    let remainder = AMOUNT_M1 - REPAYMENT_B;
    assert_eq!(remainder, 555 * STROOPS_PER_UNIT);
    assert_eq!(f.balance(&f.funder_b), funder_before + REPAYMENT_B);
    // The supplier's total is the earlier advance plus the remainder.
    assert_eq!(f.balance(&f.supplier), PRINCIPAL + remainder);
    assert_eq!(f.balance(&f.supplier), 1_955 * STROOPS_PER_UNIT);

    // The funder is net ahead by exactly repayment - principal.
    assert_eq!(
        f.balance(&f.funder_b),
        FUNDER_INITIAL_BALANCE - PRINCIPAL + REPAYMENT_B
    );

    // Escrow is fully drained and accounted for.
    assert_eq!(f.escrow_balance(), 0);
    assert_eq!(f.client.get_milestone(&m1).funded_amount, 0);
    assert_eq!(f.client.get_milestone(&m1).status, MilestoneStatus::Settled);
    assert_eq!(
        f.client.get_finance_position(&m1).status,
        FinancePositionStatus::Repaid
    );
    assert!(!f.client.has_active_finance_position(&m1));
}

#[test]
fn settlement_conserves_value_exactly() {
    let f = setup();
    let (_, m1, _) = f.financed_and_verified();

    f.client.settle_milestone(&m1, &f.supplier);

    // Everything the buyer protected ended up with the funder and supplier,
    // and nothing was created or lost.
    let funder_received = f.balance(&f.funder_b) - (FUNDER_INITIAL_BALANCE - PRINCIPAL);
    let supplier_from_escrow = f.balance(&f.supplier) - PRINCIPAL;
    assert_eq!(funder_received + supplier_from_escrow, AMOUNT_M1);
    assert_eq!(f.escrow_balance(), 0);
}

#[test]
fn unfinanced_settlement_pays_the_whole_milestone_to_the_supplier() {
    let f = setup();
    let (_, m1, _) = f.unfinanced_and_verified();

    f.client.settle_milestone(&m1, &f.supplier);

    assert_eq!(f.balance(&f.supplier), AMOUNT_M1);
    assert_eq!(f.escrow_balance(), 0);
    assert_eq!(f.client.get_milestone(&m1).status, MilestoneStatus::Settled);
    // No funder was ever involved.
    assert_eq!(f.balance(&f.funder_a), FUNDER_INITIAL_BALANCE);
    assert_eq!(f.balance(&f.funder_b), FUNDER_INITIAL_BALANCE);
}

#[test]
fn the_funder_can_also_trigger_settlement() {
    let f = setup();
    let (_, m1, _) = f.financed_and_verified();

    // Neither beneficiary can withhold the other's money by refusing to act.
    f.env.mock_auths(&[MockAuth {
        address: &f.funder_b,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "settle_milestone",
            args: (m1, f.funder_b.clone()).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    f.client.settle_milestone(&m1, &f.funder_b);

    assert_eq!(f.client.get_milestone(&m1).status, MilestoneStatus::Settled);
    assert_eq!(
        f.balance(&f.supplier),
        PRINCIPAL + (AMOUNT_M1 - REPAYMENT_B)
    );
}

#[test]
fn an_outsider_cannot_trigger_settlement() {
    let f = setup();
    let (_, m1, _) = f.financed_and_verified();

    for impostor in [f.outsider.clone(), f.funder_a.clone(), f.attestor.clone()] {
        f.env.mock_auths(&[MockAuth {
            address: &impostor,
            invoke: &MockAuthInvoke {
                contract: &f.contract_id,
                fn_name: "settle_milestone",
                args: (m1, impostor.clone()).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        assert_eq!(
            f.client.try_settle_milestone(&m1, &impostor),
            Err(Ok(Error::Unauthorized)),
        );
    }

    f.env.mock_all_auths();
    assert_eq!(f.escrow_balance(), AMOUNT_M1);
}

#[test]
fn double_settlement_is_rejected() {
    let f = setup();
    let (_, m1, _) = f.financed_and_verified();
    f.client.settle_milestone(&m1, &f.supplier);

    let supplier_after = f.balance(&f.supplier);
    let funder_after = f.balance(&f.funder_b);

    assert_eq!(
        f.client.try_settle_milestone(&m1, &f.supplier),
        Err(Ok(Error::InvalidMilestoneStatus)),
    );

    // Nobody was paid twice.
    assert_eq!(f.balance(&f.supplier), supplier_after);
    assert_eq!(f.balance(&f.funder_b), funder_after);
    assert_eq!(f.escrow_balance(), 0);
}

#[test]
fn an_unverified_milestone_cannot_be_settled() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();
    f.client.fund_milestone(&m1, &AMOUNT_M1, &f.usdc);

    // Funded but not verified.
    assert_eq!(
        f.client.try_settle_milestone(&m1, &f.supplier),
        Err(Ok(Error::InvalidMilestoneStatus)),
    );

    // Submitted but not yet attested.
    f.client.submit_evidence(&m1, &f.evidence(1));
    assert_eq!(
        f.client.try_settle_milestone(&m1, &f.supplier),
        Err(Ok(Error::InvalidMilestoneStatus)),
    );
    assert_eq!(f.escrow_balance(), AMOUNT_M1);
}

// ===========================================================================
// PKG-04 — Disputes
// ===========================================================================

#[test]
fn a_dispute_freezes_the_milestone() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();
    f.client.fund_milestone(&m1, &AMOUNT_M1, &f.usdc);
    f.client.submit_evidence(&m1, &f.evidence(1));

    let dispute_id = f.client.open_dispute(&m1, &f.buyer);

    let dispute = f.client.get_milestone_dispute(&m1);
    assert_eq!(dispute.id, dispute_id);
    assert_eq!(dispute.milestone_id, m1);
    assert_eq!(dispute.opened_by, f.buyer);
    assert_eq!(dispute.resolver, f.resolver);
    assert_eq!(dispute.status, DisputeStatus::Open);
    assert_eq!(
        f.client.get_milestone(&m1).status,
        MilestoneStatus::Disputed
    );
    // Escrow is frozen in place, not moved.
    assert_eq!(f.escrow_balance(), AMOUNT_M1);
}

#[test]
fn a_disputed_milestone_cannot_be_normally_settled() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();
    f.client.fund_milestone(&m1, &AMOUNT_M1, &f.usdc);
    f.client.submit_evidence(&m1, &f.evidence(1));
    f.client.open_dispute(&m1, &f.buyer);

    assert_eq!(
        f.client.try_settle_milestone(&m1, &f.supplier),
        Err(Ok(Error::InvalidMilestoneStatus)),
    );
    // Nor can it be attested around.
    assert_eq!(
        f.client.try_attest_milestone(&m1, &f.evidence(1)),
        Err(Ok(Error::InvalidMilestoneStatus)),
    );
    assert_eq!(f.escrow_balance(), AMOUNT_M1);
}

#[test]
fn both_counterparties_may_open_a_dispute() {
    let f = setup();
    let (_, m1, m2) = f.active_order_with_two_milestones();
    f.client.fund_milestone(&m1, &AMOUNT_M1, &f.usdc);
    f.client.fund_milestone(&m2, &AMOUNT_M2, &f.usdc);

    f.client.open_dispute(&m1, &f.buyer);
    f.client.open_dispute(&m2, &f.supplier);

    assert_eq!(f.client.get_milestone_dispute(&m1).opened_by, f.buyer);
    assert_eq!(f.client.get_milestone_dispute(&m2).opened_by, f.supplier);
}

#[test]
fn an_outsider_cannot_open_a_dispute() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();
    f.client.fund_milestone(&m1, &AMOUNT_M1, &f.usdc);

    for impostor in [f.outsider.clone(), f.attestor.clone(), f.funder_a.clone()] {
        f.env.mock_auths(&[MockAuth {
            address: &impostor,
            invoke: &MockAuthInvoke {
                contract: &f.contract_id,
                fn_name: "open_dispute",
                args: (m1, impostor.clone()).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        assert_eq!(
            f.client.try_open_dispute(&m1, &impostor),
            Err(Ok(Error::Unauthorized)),
        );
    }

    f.env.mock_all_auths();
    assert_eq!(f.client.get_milestone(&m1).status, MilestoneStatus::Funded);
}

#[test]
fn a_verified_milestone_cannot_be_dragged_into_dispute() {
    let f = setup();
    let (_, m1, _) = f.unfinanced_and_verified();

    assert_eq!(
        f.client.try_open_dispute(&m1, &f.buyer),
        Err(Ok(Error::InvalidMilestoneStatus)),
    );
}

#[test]
fn a_dispute_cannot_be_opened_twice() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();
    f.client.fund_milestone(&m1, &AMOUNT_M1, &f.usdc);
    f.client.open_dispute(&m1, &f.buyer);

    assert_eq!(
        f.client.try_open_dispute(&m1, &f.supplier),
        Err(Ok(Error::InvalidMilestoneStatus)),
    );
}

#[test]
fn the_wrong_resolver_cannot_resolve() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();
    f.client.fund_milestone(&m1, &AMOUNT_M1, &f.usdc);
    f.client.open_dispute(&m1, &f.buyer);

    for impostor in [
        f.buyer.clone(),
        f.supplier.clone(),
        f.attestor.clone(),
        f.outsider.clone(),
    ] {
        f.env.mock_auths(&[MockAuth {
            address: &impostor,
            invoke: &MockAuthInvoke {
                contract: &f.contract_id,
                fn_name: "resolve_dispute",
                args: (m1, DisputeResolution::Refund).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        assert!(
            f.client
                .try_resolve_dispute(&m1, &DisputeResolution::Refund)
                .is_err(),
            "only the assigned resolver may resolve"
        );
    }

    f.env.mock_all_auths();
    assert_eq!(f.escrow_balance(), AMOUNT_M1);
    assert_eq!(f.balance(&f.buyer), BUYER_INITIAL_BALANCE - AMOUNT_M1);
}

#[test]
fn resolving_as_settle_returns_the_milestone_to_verified() {
    let f = setup();
    let (_, m1, _) = f.milestone_seeking_finance();
    let (_, offer_b) = f.competing_offers(m1);
    f.client.accept_offer(&offer_b);
    f.client.fund_advance(&m1);
    f.client.open_dispute(&m1, &f.buyer);

    f.client.resolve_dispute(&m1, &DisputeResolution::Settle);

    assert_eq!(
        f.client.get_milestone(&m1).status,
        MilestoneStatus::Verified
    );
    assert_eq!(
        f.client.get_milestone_dispute(&m1).status,
        DisputeStatus::ResolvedSettle
    );

    // The normal funder-first waterfall then applies.
    f.client.settle_milestone(&m1, &f.supplier);
    assert_eq!(
        f.balance(&f.funder_b),
        FUNDER_INITIAL_BALANCE - PRINCIPAL + REPAYMENT_B
    );
    assert_eq!(
        f.balance(&f.supplier),
        PRINCIPAL + (AMOUNT_M1 - REPAYMENT_B)
    );
    assert_eq!(f.escrow_balance(), 0);
}

#[test]
fn refund_returns_escrow_to_the_buyer() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();
    f.client.fund_milestone(&m1, &AMOUNT_M1, &f.usdc);
    f.client.open_dispute(&m1, &f.buyer);

    f.client.resolve_dispute(&m1, &DisputeResolution::Refund);

    // The buyer is made whole for this milestone only.
    assert_eq!(f.balance(&f.buyer), BUYER_INITIAL_BALANCE);
    assert_eq!(f.escrow_balance(), 0);
    assert_eq!(f.client.get_milestone(&m1).funded_amount, 0);
    assert_eq!(
        f.client.get_milestone(&m1).status,
        MilestoneStatus::Refunded
    );
    assert_eq!(
        f.client.get_milestone_dispute(&m1).status,
        DisputeStatus::ResolvedRefund
    );
    // The supplier received nothing.
    assert_eq!(f.balance(&f.supplier), 0);
}

#[test]
fn a_refund_does_not_reverse_a_funder_advance() {
    let f = setup();
    let (_, m1, _) = f.milestone_seeking_finance();
    let (_, offer_b) = f.competing_offers(m1);
    f.client.accept_offer(&offer_b);
    f.client.fund_advance(&m1);
    f.client.open_dispute(&m1, &f.buyer);

    f.client.resolve_dispute(&m1, &DisputeResolution::Refund);

    // Buyer escrow goes back to the buyer.
    assert_eq!(f.balance(&f.buyer), BUYER_INITIAL_BALANCE);
    // But the advance already paid is NOT clawed back: it left the funder's
    // wallet for the supplier's, and this contract cannot reach into either.
    assert_eq!(f.balance(&f.supplier), PRINCIPAL);
    assert_eq!(f.balance(&f.funder_b), FUNDER_INITIAL_BALANCE - PRINCIPAL);
    // The position records that it ended without repayment from escrow.
    let position = f.client.get_finance_position(&m1);
    assert_eq!(position.status, FinancePositionStatus::Closed);
    assert_eq!(position.principal, PRINCIPAL);
    assert!(!f.client.has_active_finance_position(&m1));
    assert_eq!(f.escrow_balance(), 0);
}

#[test]
fn a_refunded_milestone_is_terminal() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();
    f.client.fund_milestone(&m1, &AMOUNT_M1, &f.usdc);
    f.client.open_dispute(&m1, &f.buyer);
    f.client.resolve_dispute(&m1, &DisputeResolution::Refund);

    assert_eq!(
        f.client.try_settle_milestone(&m1, &f.supplier),
        Err(Ok(Error::InvalidMilestoneStatus)),
    );
    assert_eq!(
        f.client.try_fund_milestone(&m1, &AMOUNT_M1, &f.usdc),
        Err(Ok(Error::InvalidMilestoneStatus)),
    );
    assert_eq!(
        f.client.try_open_dispute(&m1, &f.buyer),
        Err(Ok(Error::InvalidMilestoneStatus)),
    );
    assert_eq!(f.balance(&f.buyer), BUYER_INITIAL_BALANCE);
}

#[test]
fn a_dispute_cannot_be_resolved_twice() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();
    f.client.fund_milestone(&m1, &AMOUNT_M1, &f.usdc);
    f.client.open_dispute(&m1, &f.buyer);
    f.client.resolve_dispute(&m1, &DisputeResolution::Settle);

    assert_eq!(
        f.client
            .try_resolve_dispute(&m1, &DisputeResolution::Refund),
        Err(Ok(Error::InvalidMilestoneStatus)),
    );
}

// ---------------------------------------------------------------------------
// Dispute isolation — AGENT.md §9A.5
// ---------------------------------------------------------------------------

#[test]
fn a_delivery_dispute_does_not_disturb_earlier_settled_milestones() {
    let f = setup();
    // A four-stage commercial order: raw materials, production, shipment,
    // delivery. The contract knows none of those words; the labels live
    // off-chain and only the amounts and evidence digests are on chain.
    let order_id = f
        .client
        .create_order(&f.buyer, &f.supplier, &f.attestor, &f.resolver);
    let stage = 500 * STROOPS_PER_UNIT;
    let m1 = f.client.create_milestone(&order_id, &stage, &None);
    let m2 = f.client.create_milestone(&order_id, &stage, &None);
    let m3 = f.client.create_milestone(&order_id, &stage, &None);
    let m4 = f.client.create_milestone(&order_id, &stage, &None);
    f.client.accept_order(&order_id);

    // M1-M3 run to settlement.
    for (i, m) in [m1, m2, m3].iter().enumerate() {
        f.client.fund_milestone(m, &stage, &f.usdc);
        let hash = f.evidence((i as u8) + 1);
        f.client.submit_evidence(m, &hash);
        f.client.attest_milestone(m, &hash);
        f.client.settle_milestone(m, &f.supplier);
    }
    let supplier_after_three = f.balance(&f.supplier);
    assert_eq!(supplier_after_three, 3 * stage);

    // M4 (delivery) is funded and then disputed.
    f.client.fund_milestone(&m4, &stage, &f.usdc);
    f.client.open_dispute(&m4, &f.buyer);

    // Only M4 is frozen.
    assert_eq!(
        f.client.get_milestone(&m4).status,
        MilestoneStatus::Disputed
    );
    for m in [m1, m2, m3] {
        assert_eq!(f.client.get_milestone(&m).status, MilestoneStatus::Settled);
        assert_eq!(f.client.get_milestone(&m).funded_amount, 0);
    }
    // Previously settled money is untouched, and only M4's escrow is held.
    assert_eq!(f.balance(&f.supplier), supplier_after_three);
    assert_eq!(f.escrow_balance(), stage);

    // Refunding M4 returns only M4's escrow.
    f.client.resolve_dispute(&m4, &DisputeResolution::Refund);
    assert_eq!(f.balance(&f.supplier), supplier_after_three);
    assert_eq!(f.escrow_balance(), 0);
    assert_eq!(f.balance(&f.buyer), BUYER_INITIAL_BALANCE - 3 * stage);
    // The order is finished: every milestone reached a terminal state.
    assert_eq!(f.client.get_order(&order_id).status, OrderStatus::Completed);
}

#[test]
fn settling_the_last_milestone_completes_the_order() {
    let f = setup();
    let (order_id, m1, m2) = f.active_order_with_two_milestones();

    for (m, amount) in [(m1, AMOUNT_M1), (m2, AMOUNT_M2)] {
        f.client.fund_milestone(&m, &amount, &f.usdc);
        let hash = f.evidence(m as u8);
        f.client.submit_evidence(&m, &hash);
        f.client.attest_milestone(&m, &hash);
        assert_eq!(f.client.get_order(&order_id).status, OrderStatus::Active);
        f.client.settle_milestone(&m, &f.supplier);
    }

    assert_eq!(f.client.get_order(&order_id).status, OrderStatus::Completed);
    assert_eq!(f.balance(&f.supplier), AMOUNT_M1 + AMOUNT_M2);
    assert_eq!(f.escrow_balance(), 0);
}

// ---------------------------------------------------------------------------
// Deadlines — invariants 25 and 26
// ---------------------------------------------------------------------------

#[test]
fn a_missed_deadline_moves_no_funds_and_changes_no_state() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();
    let deadline = f.now() + 60 * 60;
    let m_deadlined = {
        // A fresh order so the milestone can carry a deadline.
        let order_id = f
            .client
            .create_order(&f.buyer, &f.supplier, &f.attestor, &f.resolver);
        let m = f
            .client
            .create_milestone(&order_id, &AMOUNT_M1, &Some(deadline));
        f.client.accept_order(&order_id);
        f.client.fund_milestone(&m, &AMOUNT_M1, &f.usdc);
        m
    };
    let _ = m1;

    let before = f.client.get_milestone(&m_deadlined);
    let escrow_before = f.escrow_balance();
    let buyer_before = f.balance(&f.buyer);
    let supplier_before = f.balance(&f.supplier);

    // Sail past the deadline by a wide margin.
    f.advance_time(30 * 24 * 60 * 60);

    let after = f.client.get_milestone(&m_deadlined);
    assert_eq!(after.status, before.status);
    assert_eq!(after.funded_amount, before.funded_amount);
    assert_eq!(after.deadline, Some(deadline));
    assert_eq!(f.escrow_balance(), escrow_before);
    assert_eq!(f.balance(&f.buyer), buyer_before);
    assert_eq!(f.balance(&f.supplier), supplier_before);

    // Expiry grants nobody a shortcut: settlement still needs verification,
    // and a refund still needs an authorized dispute resolution.
    assert_eq!(
        f.client.try_settle_milestone(&m_deadlined, &f.supplier),
        Err(Ok(Error::InvalidMilestoneStatus)),
    );
    assert_eq!(
        f.client
            .try_resolve_dispute(&m_deadlined, &DisputeResolution::Refund),
        Err(Ok(Error::DisputeNotFound)),
    );
    assert_eq!(f.escrow_balance(), escrow_before);
}

#[test]
fn a_late_milestone_still_settles_normally_once_verified() {
    let f = setup();
    let order_id = f
        .client
        .create_order(&f.buyer, &f.supplier, &f.attestor, &f.resolver);
    let m = f
        .client
        .create_milestone(&order_id, &AMOUNT_M1, &Some(f.now() + 60));
    f.client.accept_order(&order_id);
    f.client.fund_milestone(&m, &AMOUNT_M1, &f.usdc);

    // Delayed by weeks of sea freight, then delivered and verified.
    f.advance_time(45 * 24 * 60 * 60);
    let hash = f.evidence(3);
    f.client.submit_evidence(&m, &hash);
    f.client.attest_milestone(&m, &hash);
    f.client.settle_milestone(&m, &f.supplier);

    // Lateness carries no penalty in the contract.
    assert_eq!(f.balance(&f.supplier), AMOUNT_M1);
    assert_eq!(f.client.get_milestone(&m).status, MilestoneStatus::Settled);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[test]
fn the_lifecycle_emits_its_events() {
    let f = setup();
    let (_, m1, _) = f.active_order_with_two_milestones();
    f.client.fund_milestone(&m1, &AMOUNT_M1, &f.usdc);

    let hash = f.evidence(1);
    f.client.submit_evidence(&m1, &hash);
    assert_eq!(
        f.last_event_name(),
        Symbol::new(&f.env, "evidence_submitted")
    );

    f.client.open_dispute(&m1, &f.buyer);
    assert_eq!(f.last_event_name(), Symbol::new(&f.env, "dispute_opened"));

    f.client.resolve_dispute(&m1, &DisputeResolution::Settle);
    assert_eq!(f.last_event_name(), Symbol::new(&f.env, "dispute_resolved"));

    f.client.settle_milestone(&m1, &f.supplier);
    assert_eq!(
        f.last_event_name(),
        Symbol::new(&f.env, "milestone_settled")
    );
}

#[test]
fn verification_and_refund_emit_their_events() {
    let f = setup();
    let (_, m1, m2) = f.active_order_with_two_milestones();
    f.client.fund_milestone(&m1, &AMOUNT_M1, &f.usdc);
    let hash = f.evidence(1);
    f.client.submit_evidence(&m1, &hash);
    f.client.attest_milestone(&m1, &hash);
    assert_eq!(
        f.last_event_name(),
        Symbol::new(&f.env, "milestone_verified")
    );

    f.client.fund_milestone(&m2, &AMOUNT_M2, &f.usdc);
    f.client.open_dispute(&m2, &f.buyer);
    f.client.resolve_dispute(&m2, &DisputeResolution::Refund);
    // dispute_resolved is emitted last; the refund event precedes it.
    assert_eq!(f.last_event_name(), Symbol::new(&f.env, "dispute_resolved"));
    assert_eq!(f.balance(&f.buyer), BUYER_INITIAL_BALANCE - AMOUNT_M1);
}

// ===========================================================================
// Phase 1 exit gate — the complete financial lifecycle
// ===========================================================================

#[test]
fn the_full_milvance_lifecycle_works_end_to_end() {
    let f = setup();

    // create order -> create milestone
    let order_id = f
        .client
        .create_order(&f.buyer, &f.supplier, &f.attestor, &f.resolver);
    let m1 = f.client.create_milestone(&order_id, &AMOUNT_M1, &None);
    f.client.accept_order(&order_id);

    // fund milestone: buyer protects 2,000 without prepaying the supplier
    f.client.fund_milestone(&m1, &AMOUNT_M1, &f.usdc);
    assert_eq!(f.escrow_balance(), AMOUNT_M1);
    assert_eq!(
        f.balance(&f.supplier),
        0,
        "buyer escrow is not supplier cash"
    );

    // request finance -> receive offers -> accept the better one
    f.client
        .request_finance(&m1, &PRINCIPAL, &(f.now() + REQUEST_TTL));
    let (_, offer_b) = f.competing_offers(m1);
    f.client.accept_offer(&offer_b);

    // funder advances supplier from the funder's OWN capital
    let escrow_before_advance = f.escrow_balance();
    f.client.fund_advance(&m1);
    assert_eq!(f.balance(&f.supplier), PRINCIPAL, "supplier has cash now");
    assert_eq!(
        f.escrow_balance(),
        escrow_before_advance,
        "buyer escrow untouched by the advance"
    );
    assert_eq!(f.balance(&f.funder_b), FUNDER_INITIAL_BALANCE - PRINCIPAL);

    // submit evidence -> attestor verifies
    let hash = f.evidence(42);
    f.client.submit_evidence(&m1, &hash);
    f.client.attest_milestone(&m1, &hash);
    assert_eq!(
        f.client.get_milestone(&m1).status,
        MilestoneStatus::Verified
    );

    // funder-first settlement
    f.client.settle_milestone(&m1, &f.supplier);

    // Final position, matching AGENT.md §9.4 exactly.
    assert_eq!(
        f.balance(&f.funder_b),
        FUNDER_INITIAL_BALANCE - PRINCIPAL + REPAYMENT_B
    );
    assert_eq!(f.balance(&f.supplier), 1_955 * STROOPS_PER_UNIT);
    assert_eq!(f.balance(&f.buyer), BUYER_INITIAL_BALANCE - AMOUNT_M1);
    assert_eq!(f.escrow_balance(), 0);
    assert_eq!(f.client.get_milestone(&m1).status, MilestoneStatus::Settled);
    assert_eq!(
        f.client.get_finance_position(&m1).status,
        FinancePositionStatus::Repaid
    );
    assert_eq!(f.client.get_order(&order_id).status, OrderStatus::Completed);
}

#[test]
fn the_contract_stays_generic_across_a_shipment_scenario() {
    let f = setup();
    // Production / QC + handed to carrier / delivery confirmed — the same
    // state machine, with no vessel, carrier, port, bill of lading or customs
    // concept anywhere in the contract.
    let order_id = f
        .client
        .create_order(&f.buyer, &f.supplier, &f.attestor, &f.resolver);
    let stage = 400 * STROOPS_PER_UNIT;
    let production = f.client.create_milestone(&order_id, &stage, &None);
    let handed_to_carrier =
        f.client
            .create_milestone(&order_id, &stage, &Some(f.now() + 7 * 24 * 60 * 60));
    let delivery = f
        .client
        .create_milestone(&order_id, &stage, &Some(f.now() + 30 * 24 * 60 * 60));
    f.client.accept_order(&order_id);

    // The buyer protects the shipment stage; a funder bridges the supplier's
    // liquidity while the goods are in transit.
    f.client.fund_milestone(&handed_to_carrier, &stage, &f.usdc);
    f.client
        .request_finance(&handed_to_carrier, &(stage / 2), &(f.now() + REQUEST_TTL));
    let offer = f.client.make_offer(
        &handed_to_carrier,
        &f.funder_a,
        &(stage / 2),
        &(stage / 2 + STROOPS_PER_UNIT),
        &(f.now() + OFFER_TTL),
    );
    f.client.accept_offer(&offer);
    f.client.fund_advance(&handed_to_carrier);
    assert_eq!(f.balance(&f.supplier), stage / 2);

    // Weeks of sea freight pass; the deadline lapses and nothing moves.
    let escrow_mid = f.escrow_balance();
    f.advance_time(40 * 24 * 60 * 60);
    assert_eq!(f.escrow_balance(), escrow_mid);

    // Delivery is eventually evidenced and verified, late and unpenalised.
    let hash = f.evidence(5);
    f.client.submit_evidence(&handed_to_carrier, &hash);
    f.client.attest_milestone(&handed_to_carrier, &hash);
    f.client.settle_milestone(&handed_to_carrier, &f.supplier);

    assert_eq!(
        f.client.get_milestone(&handed_to_carrier).status,
        MilestoneStatus::Settled
    );
    // Untouched siblings keep their own state.
    assert_eq!(
        f.client.get_milestone(&production).status,
        MilestoneStatus::Unfunded
    );
    assert_eq!(
        f.client.get_milestone(&delivery).status,
        MilestoneStatus::Unfunded
    );
    assert_eq!(f.client.get_order(&order_id).status, OrderStatus::Active);
    assert_eq!(f.escrow_balance(), 0);
}

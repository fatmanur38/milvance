use soroban_sdk::contracterror;

/// Explicit, stable error codes for `MilvanceCore`.
///
/// Codes are part of the contract surface: never renumber an existing variant,
/// only append. Off-chain clients (PKG-05 bindings, PKG-08 indexer, PKG-09 UI)
/// map these to user-facing messages.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    // --- Lifecycle / configuration ---
    NotInitialized = 1,

    // --- Authorization ---
    Unauthorized = 2,

    // --- Lookup ---
    OrderNotFound = 10,
    MilestoneNotFound = 11,

    // --- State transition guards ---
    InvalidOrderStatus = 20,
    InvalidMilestoneStatus = 21,
    OrderHasNoMilestones = 22,

    // --- Domain validation ---
    InvalidParties = 30,
    InvalidAttestor = 31,
    InvalidResolver = 32,
    InvalidAmount = 33,
    InvalidDeadline = 34,
    MilestoneLimitReached = 35,
    AttestorResolverConflict = 36,

    // --- Escrow (PKG-02) ---
    /// The asset supplied by the caller is not this order's settlement asset.
    InvalidAsset = 40,
    /// The deposit would push escrow past the protected milestone amount.
    Overfunded = 41,
    /// A release would exceed the escrow this milestone actually holds.
    InsufficientEscrow = 42,
    ArithmeticOverflow = 43,

    // --- Financing (PKG-03) ---
    FinanceRequestNotFound = 50,
    /// A live finance request already exists for this milestone.
    FinanceRequestActive = 51,
    FinanceRequestExpired = 52,
    InvalidFinanceRequestStatus = 53,
    /// The milestone does not hold its full protected amount, so it is not
    /// financeable (invariant 23).
    MilestoneNotFullyFunded = 54,
    OfferNotFound = 55,
    InvalidOfferStatus = 56,
    OfferExpired = 57,
    /// Offers must match the requested principal exactly, so competing offers
    /// differ only in repayment.
    PrincipalMismatch = 58,
    /// `repayment < principal`.
    InvalidRepayment = 59,
    /// `repayment > funded milestone amount` (invariant 2).
    RepaymentExceedsEscrow = 60,
    OfferLimitReached = 61,
    /// The funder must be independent of buyer, supplier, attestor and resolver.
    InvalidFunder = 62,
    NoAcceptedOffer = 63,
    /// An ACTIVE FinancePosition already exists for this milestone (invariant 1).
    AlreadyFinanced = 64,
    FinancePositionNotFound = 65,
    /// An expiry timestamp is in the past or beyond the allowed window.
    InvalidExpiry = 66,
    /// Defensive: the funder advance altered buyer milestone escrow. This must
    /// be unreachable; reaching it reverts the whole invocation.
    EscrowMutated = 67,
    /// The accepted offer has not expired yet, so it cannot be released.
    OfferStillLive = 68,

    // --- Evidence, attestation, settlement, dispute (PKG-04) ---
    /// No evidence has been committed for this milestone.
    EvidenceNotFound = 70,
    /// The attestor signed for a different digest than the one on record.
    EvidenceMismatch = 71,
    /// An all-zero digest is rejected as an unset sentinel.
    InvalidEvidence = 72,
    DisputeNotFound = 73,
    DisputeAlreadyOpen = 74,
    InvalidDisputeStatus = 75,
    /// The milestone holds no escrow to pay out or return.
    NothingToSettle = 76,
}

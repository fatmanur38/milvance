//! Financing validation and the funder advance (PKG-03).
//!
//! # The economic separation this module must never blur
//!
//! ```text
//! Buyer escrow  = protected milestone payment, held by THIS CONTRACT.
//! Funder advance = separate capital, moved FUNDER WALLET → SUPPLIER WALLET.
//! ```
//!
//! [`transfer_advance`] is the only token movement in this module, and it moves
//! value **between two user wallets**. The contract is not the sender and not
//! the recipient: no contract-held escrow is debited, and `funded_amount` is
//! never written here. The buyer's protected amount is read only as an
//! underwriting *ceiling* on repayment (invariant 2).
//!
//! The funder is repaid first out of that protected escrow only after the
//! milestone is verified — which is PKG-04, not this package.

use soroban_sdk::{token, Address, Env};

use crate::errors::Error;
use crate::types::{FundingOffer, Milestone, Order};

/// Validates a proposed offer's economics against the protected milestone.
///
/// Enforces, in order:
/// - `principal > 0` (invariant 3),
/// - `repayment >= principal` (invariant 4),
/// - `repayment <= funded milestone amount` (invariant 2).
///
/// The ceiling is the escrow the milestone **actually holds**, not the amount
/// it was declared for, so a funder can never be promised more than the
/// verified milestone can ever pay out.
pub(crate) fn validate_economics(
    milestone: &Milestone,
    principal: i128,
    repayment: i128,
) -> Result<(), Error> {
    if principal <= 0 {
        return Err(Error::InvalidAmount);
    }
    if repayment < principal {
        return Err(Error::InvalidRepayment);
    }
    if repayment > milestone.funded_amount {
        return Err(Error::RepaymentExceedsEscrow);
    }
    Ok(())
}

/// The funder must be independent of every other role on the order.
///
/// A supplier funding itself is not an advance. A buyer funding it would blur
/// protected escrow with working capital. An attestor or resolver funding it
/// would give the party who verifies (or reviews) the milestone a direct
/// financial stake in that verification succeeding.
pub(crate) fn validate_funder(order: &Order, funder: &Address) -> Result<(), Error> {
    if *funder == order.buyer
        || *funder == order.supplier
        || *funder == order.attestor
        || *funder == order.resolver
    {
        return Err(Error::InvalidFunder);
    }
    Ok(())
}

/// Whether `expires_at` is still in the future.
pub(crate) fn is_live(env: &Env, expires_at: u64) -> bool {
    env.ledger().timestamp() < expires_at
}

/// Validates a caller-supplied expiry: strictly in the future, and no further
/// out than `max_window` seconds.
///
/// The upper bound matters for offers: it keeps an offer's business validity
/// inside its temporary-storage lifetime, so an offer expires by an explicit
/// timestamp check rather than by disappearing.
pub(crate) fn validate_expiry(env: &Env, expires_at: u64, max_window: u64) -> Result<(), Error> {
    let now = env.ledger().timestamp();
    if expires_at <= now {
        return Err(Error::InvalidExpiry);
    }
    if expires_at > now + max_window {
        return Err(Error::InvalidExpiry);
    }
    Ok(())
}

/// Moves the advance **from the funder's wallet to the supplier's wallet**.
///
/// This is the single most important boundary in Milvance, so it is worth
/// stating plainly: neither `from` nor `to` is this contract. Contract-held
/// buyer escrow is not the source, is not touched, and cannot be touched by
/// this function — it has no access to `escrow::release` and never writes
/// `Milestone.funded_amount`.
///
/// The asset is the order's settlement asset, so the advance and the eventual
/// repayment are denominated identically.
pub(crate) fn transfer_advance(
    env: &Env,
    order: &Order,
    offer: &FundingOffer,
) -> Result<(), Error> {
    if offer.principal <= 0 {
        return Err(Error::InvalidAmount);
    }

    token::Client::new(env, &order.asset).transfer(
        &offer.funder,
        &order.supplier,
        &offer.principal,
    );

    Ok(())
}

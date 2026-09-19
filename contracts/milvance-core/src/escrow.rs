//! Milestone escrow accounting (PKG-02).
//!
//! Every movement of buyer money into or out of a milestone goes through this
//! module, and every movement is paired with the matching change to
//! `Milestone.funded_amount` in the same function. Escrow accounting and the
//! token transfer can therefore never drift apart.
//!
//! Escrow held here is **buyer money protecting a milestone payment**. It is not
//! a supplier balance, and nothing in PKG-02 can pay it out: [`release`] exists
//! for PKG-04 settlement and refund, and is not reachable from any exported
//! contract function in this package.

use soroban_sdk::{token, Address, Env};

use crate::errors::Error;
use crate::types::{Milestone, Order};

/// Transfers `amount` of the order's asset from the buyer into contract escrow
/// and credits it to this milestone.
///
/// Escrow is credited to exactly one milestone, so funds deposited for
/// milestone A can never be counted towards milestone B (invariant 13).
///
/// Rejects any deposit that would push `funded_amount` past `amount`
/// (invariant 5), using checked arithmetic throughout (invariant 21).
pub(crate) fn deposit(
    env: &Env,
    order: &Order,
    milestone: &mut Milestone,
    amount: i128,
) -> Result<(), Error> {
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    let new_total = milestone
        .funded_amount
        .checked_add(amount)
        .ok_or(Error::ArithmeticOverflow)?;

    if new_total > milestone.amount {
        return Err(Error::Overfunded);
    }

    token::Client::new(env, &order.asset).transfer(
        &order.buyer,
        env.current_contract_address(),
        &amount,
    );

    milestone.funded_amount = new_total;
    Ok(())
}

/// The single exit path for milestone escrow.
///
/// Debits `amount` from this milestone's escrow and transfers it to `to`. A
/// release can never exceed what this milestone actually holds, which is what
/// makes "funder repayment + supplier payout cannot exceed locked funds"
/// (invariant 12) and "funds cannot leak across milestones" (invariant 13)
/// enforceable by construction rather than by convention.
///
/// Used by PKG-04 for the funder-first settlement waterfall and for buyer
/// refunds. It is the only way escrow can ever leave the contract.
pub(crate) fn release(
    env: &Env,
    order: &Order,
    milestone: &mut Milestone,
    to: &Address,
    amount: i128,
) -> Result<(), Error> {
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }
    if amount > milestone.funded_amount {
        return Err(Error::InsufficientEscrow);
    }

    let remaining = milestone
        .funded_amount
        .checked_sub(amount)
        .ok_or(Error::ArithmeticOverflow)?;

    token::Client::new(env, &order.asset).transfer(&env.current_contract_address(), to, &amount);

    milestone.funded_amount = remaining;
    Ok(())
}

/// Whether the milestone holds its full protected amount.
///
/// This is the MVP financeability precondition (AGENT.md §9.5, invariant 23): a
/// partially funded milestone is **not** fully protected and must not become
/// financeable, because the funder's underwriting input would be ambiguous.
///
/// PKG-03 adds the remaining financeability conditions (no active finance
/// position, order still active) on top of this predicate.
pub(crate) fn is_fully_funded(milestone: &Milestone) -> bool {
    milestone.funded_amount == milestone.amount
}

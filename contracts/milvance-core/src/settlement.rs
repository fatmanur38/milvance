//! Settlement waterfall (PKG-04).
//!
//! The split is computed before any transfer happens, and the sum of the two
//! legs always equals the escrow the milestone actually holds. That is what
//! makes "funder repayment + supplier payout cannot exceed locked funds"
//! (invariant 12) arithmetic rather than a matter of ordering.
//!
//! ```text
//! financed:    locked ├── repayment → funder   (paid FIRST)
//!                     └── remainder → supplier
//! unfinanced:  locked ────────────→ supplier
//! ```

use crate::errors::Error;
use crate::types::{FinancePosition, FinancePositionStatus, Milestone};

/// How a verified milestone's escrow divides.
pub(crate) struct Waterfall {
    /// Repaid to the funder first. Zero when the milestone was unfinanced.
    pub funder_repayment: i128,
    /// The supplier's remainder.
    pub supplier_payout: i128,
}

/// Computes the split for a verified milestone.
///
/// The funder is made whole first; the supplier receives what is left. A
/// repayment larger than the escrow is rejected rather than silently capped, so
/// an impossible position can never pay out at the supplier's expense.
pub(crate) fn compute(
    milestone: &Milestone,
    position: Option<&FinancePosition>,
) -> Result<Waterfall, Error> {
    let locked = milestone.funded_amount;
    if locked <= 0 {
        return Err(Error::NothingToSettle);
    }

    match position {
        Some(position) if position.status == FinancePositionStatus::Active => {
            if position.repayment > locked {
                return Err(Error::RepaymentExceedsEscrow);
            }
            let supplier_payout = locked
                .checked_sub(position.repayment)
                .ok_or(Error::ArithmeticOverflow)?;

            Ok(Waterfall {
                funder_repayment: position.repayment,
                supplier_payout,
            })
        }
        // No position, or one that is no longer active: the whole protected
        // amount belongs to the supplier.
        _ => Ok(Waterfall {
            funder_repayment: 0,
            supplier_payout: locked,
        }),
    }
}

impl Waterfall {
    /// Total escrow this waterfall releases.
    pub(crate) fn total(&self) -> Result<i128, Error> {
        self.funder_repayment
            .checked_add(self.supplier_payout)
            .ok_or(Error::ArithmeticOverflow)
    }
}

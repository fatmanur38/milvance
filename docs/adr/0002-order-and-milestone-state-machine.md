# ADR 0002 — Order and milestone state machine

- **Status:** Accepted
- **Date:** 2026-09-19
- **Package:** PKG-01

## Context

`MilvanceCore` needs a domain foundation before any value can move. The choices
below constrain every later package, so they are recorded rather than left
implicit in the contract source.

## Decisions

### 1. Attestor and resolver are assigned per order, by the buyer, at creation

Both must be third parties: `attestor != buyer`, `attestor != supplier`, and the
same for `resolver`. A buyer or supplier who can attest their own milestone
defeats the verification step that settlement depends on.

Per-milestone attestors (a QC firm for production, a different party for
delivery) are plausible for the shipment model but are not MVP. Revisiting this
in PKG-04 requires an ADR.

`attestor != resolver` is also enforced (hardened after initial review). The
resolver reviews disputes about the attestor's verification, so one account
holding both roles would let a verification be reviewed by its own author.

An order therefore requires four mutually independent parties: buyer, supplier,
attestor and resolver.

### 2. The milestone set is frozen when the supplier accepts the order

Milestones may only be added while the order is `Created`. `accept_order` is
therefore a commitment to a known scope, and no party can enlarge an order the
supplier has already accepted.

An order with zero milestones cannot be accepted.

### 3. `cancel_order` is restricted to `Created`

`Created` is the only status in which no milestone can hold escrow. Unwinding an
accepted order would require returning escrow and settling any finance position,
which is dispute/refund territory (PKG-04), not cancellation.

### 4. `COMPLETED` is defined but unreachable in PKG-01

An order completes only when every milestone is terminal, which depends on
settlement. The transition belongs to PKG-04.

### 5. The settlement asset is snapshotted from config, not passed in

`create_order` takes no asset parameter; it copies `Config.usdc` onto the order.
This makes "MVP rejects non-USDC settlement assets" (invariant 20) hold by
construction, and "order asset is immutable" (invariant 19) hold because no
function writes `Order.asset` after creation.

PKG-02 must transfer against `order.asset`, not `Config.usdc`, so that a later
config change can never retroactively alter an existing order's asset.

### 6. Configuration is set by a constructor, not a callable `initialize`

`__constructor` runs exactly once, atomically with deployment, which removes the
uninitialized window and the double-initialization bug class entirely.

### 7. Spec-visible identifiers are plain `u64`

`OrderId`/`MilestoneId`/`OfferId`/`DisputeId` type aliases exist for internal
readability, but the contract spec records an alias by name without resolving
it. Generated TypeScript then references a type that is never declared, which
does not compile. Verified against `stellar contract bindings typescript`.

Identifiers in contract function signatures, `#[contracttype]` fields and
`#[contractevent]` fields are therefore written as `u64`.

### 8. `DELAYED` / `NEEDS_REVIEW` are not contract states

`MilestoneStatus` deliberately omits them. A passed deadline is a derived
read-model/UI status only (invariant 25, 26). `Milestone.deadline` is
informational and no contract path branches on it.

### 9. Events use `#[contractevent]`

Typed events are included in the contract spec, so the PKG-08 indexer can decode
them against a published schema instead of a hand-maintained one. Event topic 0
is the event name; entity ids are topics so indexer filtering stays cheap.

### 10. Milestone escrow has exactly one entry and one exit (PKG-02)

All movement of buyer money goes through `escrow::deposit` and
`escrow::release`, each of which changes `Milestone.funded_amount` in the same
function as the token transfer. Escrow accounting and custody therefore cannot
drift apart, and escrow is always attributed to exactly one milestone.

`escrow::release` is defined in PKG-02 but is not reachable from any exported
function: no PKG-02 code path can pay escrow out. PKG-04 consumes it for the
funder-first settlement waterfall and for buyer refunds.

### 11. Funding requires an `Active` order (PKG-02)

Money is only committed to a scope the supplier has accepted. Combined with
decision 3, this makes `cancel_order` (`Created`-only) and funded escrow
permanently disjoint: a cancellable order can never hold buyer money.

### 12. `fund_milestone` takes the asset as an explicit parameter (PKG-02)

The contract could read the asset from the order, but requiring the caller to
name it means a client holding a stale or wrong asset id fails loudly with
`InvalidAsset` instead of silently transferring the correct one.

Validation is against `order.asset`, not `Config.usdc`, so a future config
change can never retroactively alter an existing order's settlement asset.

### 13. Partial deposits are allowed; full protection gates financeability (PKG-02)

Deposits accumulate, but the milestone only reaches `Funded` when
`funded_amount == milestone.amount`. A partially funded milestone is never
reported as fully protected, so a funder's underwriting input is unambiguous
(§9.5, invariant 23).

### 14. Accepted offer economics are copied to persistent storage (PKG-03)

Open offers live in temporary storage (§18), but an accepted offer's economics
must survive that entry's expiry unchanged. `accept_offer` therefore copies the
selected offer into a persistent `AcceptedOffer(milestone_id)` record, and
`fund_advance` reads **that** copy, never the temporary one.

Consequences: accepted economics are immutable (invariant 7), and expiry of
temporary storage can never alter or destroy a funded position.

### 15. The temporary offer index is advisory only (PKG-03)

`MilestoneOffers(milestone_id)` is a temporary `Vec<OfferId>` that can outlive
the offer entries it names, so it may hold stale ids.

Strategy: **no guard ever reads the index.** Every financial decision resolves
the offer entry directly by id, and a missing entry is `OfferNotFound`. The
index serves `get_open_offers`, which resolves each id and drops anything
missing, cancelled, accepted, funded or expired. A re-request clears the index
so a new round cannot inherit the previous round's ids.

`TEMPORARY_BUMP_AMOUNT` (10 days) deliberately exceeds
`MAX_OFFER_VALIDITY_SECONDS` (7 days), so an offer normally dies by an explicit
timestamp check rather than by vanishing from storage.

### 16. Offers must match the requested principal exactly (PKG-03)

Competing offers differ only in `repayment`, matching the canonical example in
§9.2 and making the supplier's comparison unambiguous. Partial-principal offers
are rejected: with only one finance position allowed per milestone, a partial
advance would leave the supplier short with no way to stack a second.

### 17. The funder must be independent of every other role (PKG-03)

`funder ∉ {buyer, supplier, attestor, resolver}`. A supplier funding itself is
not an advance; a buyer funding it would blur protected escrow with working
capital; an attestor or resolver funding it would give the party who verifies
(or reviews) the milestone a direct financial stake in verification succeeding.

### 18. Duplicate-financing is the first guard in `fund_advance` (PKG-03)

Invariant 1 is checked before the weaker status guards, so a duplicate attempt
always reports `AlreadyFinanced` instead of being masked by a downstream status
mismatch. The milestone-status check remains as a second independent barrier.

A defensive `EscrowMutated` check additionally asserts that protected escrow is
bit-for-bit unchanged across the advance. It should be unreachable —
`funded_amount` is written only by the escrow module, which `fund_advance` never
calls — and reaching it reverts the whole invocation.

### 19. A stalled acceptance is recoverable by the supplier (PKG-03 hardening)

A selected funder is under no obligation to call `fund_advance`. Left alone,
a funder that simply walked away would strand the supplier behind a spent
finance request until that request expired — a **liveness** gap, not a safety
one: no value was ever at risk, but the supplier could not re-finance a
milestone they had already fully protected.

`release_expired_acceptance(milestone_id)` closes it. Supplier-authorized, and
permitted only when an accepted offer exists, has passed its expiry, was never
funded, and no `FinancePosition` exists. The position check runs first, so real
financing can never be unwound through this path.

Two shapes, and deliberately **no new milestone state**:

| Finance request | Result                                                                                                               |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| still live      | request reopens to `Open`; milestone stays `FinanceRequested`; supplier may select another offer or receive new ones |
| expired         | request closes as `Cancelled`; milestone returns to `Funded`, so `request_finance` can start a fresh round           |

The accepted-offer record is removed, which is what stops the lapsed funder
calling `fund_advance` — that function errors with `NoAcceptedOffer` without
one. The temporary offer entry, if it still exists, is marked `Cancelled` so the
lapsed selection cannot reappear as selectable.

The function moves no value: it makes no token call at all. An acceptance is a
selection, not a transfer, so there is nothing to unwind. Buyer escrow and every
wallet balance are unchanged.

A live acceptance cannot be released (`OfferStillLive`): until it expires, the
selection still belongs to the funder that won it.

## Consequences

- PKG-02 added escrow to `Milestone.funded_amount` without weakening any guard
  above.
- PKG-03/PKG-04 extend the declared `FinanceRequest`, `FundingOffer`,
  `FinancePosition` and `Dispute` types rather than redesigning the schema.
- The `attestor == resolver` allowance is an open threat-model item.

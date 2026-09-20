# Milvance — Product narrative

## What we are building

**Local-payment-powered production finance for cross-border orders.**

A buyer protects a milestone payment on Soroban instead of prepaying their
supplier. An independent funder can then advance working capital to the
supplier against that already-protected milestone. When an attestor verifies
the work, the contract repays the funder first and sends the remainder to the
supplier, atomically. Stellar Anchors connect the whole flow to the local
currency the supplier actually spends.

## The problem

A Turkish manufacturer wins a €50,000 order from a European buyer. Production
starts in three weeks. Between signing and getting paid they must pay for
fabric, dye, electricity and wages — in Turkish lira, now.

Both sides are stuck in the same impasse:

- **The buyer** will not prepay. Sending money for goods that do not exist yet
  means trusting a counterparty they may have never met, in another
  jurisdiction, with no recourse.
- **The supplier** cannot start without cash. An order is not working capital.

Today this is resolved by whoever has more leverage. The supplier borrows at
punitive rates, factors the invoice at a discount, or simply turns the order
down. Trade finance exists for exactly this gap, and it reaches large
established exporters — not the workshop with forty machines.

And even where financing exists, it often arrives in the wrong currency.
A supplier who receives USDC still cannot pay a dye house with it.

## Who this is for

|               |                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Suppliers** | Small and mid-sized manufacturers in production economies — Turkey first — who have orders but not the cash to start them |
| **Buyers**    | Brands and importers who want production to begin without prepaying a counterparty they cannot enforce against            |
| **Funders**   | Anyone with idle USDC willing to price short, specific, milestone-backed production risk                                  |
| **Platforms** | Sourcing and B2B marketplaces that already match buyers and suppliers but cannot finance them                             |

## Why this is worth solving

The gap is not a lack of willingness. It is a lack of **shared, enforceable
financial state**. The buyer's commitment, the supplier's claim and the
funder's repayment priority live in three different systems that do not trust
each other, so every deal needs intermediaries who charge for bridging that
gap — and who only bother for large deals.

Put those three facts in one place that all parties can verify and no party
controls, and the intermediary cost collapses. That is what a shared ledger is
actually good for.

## The value proposition

| For          | What changes                                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------------------------------- |
| **Supplier** | Working capital against a milestone that is already protected, in local currency, without giving up the order's margin |
| **Buyer**    | Production starts without prepaying; money is released only after someone they chose verifies the work                 |
| **Funder**   | A short, specific position with enforced repayment priority out of a visible escrow, rather than an opaque receivable  |

## Buyer prefunding is not supplier prepayment

This distinction is the product.

```text
PREPAYMENT                         PROTECTED MILESTONE
buyer ──────────────► supplier     buyer ──────────► MilvanceCore
                                                       (held)
money is gone.                     money is committed and visible,
the buyer is trusting.             but not spendable by anyone until
                                   an attestor verifies the work.
```

The buyer gets the commitment they need to make production start. The supplier
gets something real to finance against. Neither has to trust the other first.

## Why a funder exists at all

A protected milestone is a promise about the future. A supplier cannot pay
wages with a promise.

The funder converts that promise into cash today and is repaid first out of
the escrow when it is verified. This is why the two pools must never blur:
**the funder's money goes to the supplier immediately; the buyer's money never
moves until verification.** If the advance came out of escrow, the buyer would
be prepaying after all — just with extra steps.

The funder is taking real risk, and Milvance says so plainly: if the milestone
is refunded, the buyer's escrow returns to the buyer and the supplier keeps the
advance. Escrow is not a guarantee to the funder.

## Why local payments

A supplier who receives USDC has not been paid. They have been given something
they must convert before it becomes useful. Dye houses, landlords and workers
are paid in lira.

So the local-money edge is not a feature bolted on at the end — it is where the
product becomes real:

```text
local capital ─► Anchor ─► USDC ─► Milvance financing ─► supplier
                                                            │
                                                          Anchor
                                                            │
                                                           TRY
                                                            │
                                                  materials, wages, energy
```

Our north-star metric measures exactly this loop end to end, and refuses to
count a cycle whose local-money leg cannot be confirmed on chain.

## Why Stellar

- **Cheap, fast finality.** A milestone flow is many small transactions.
  Fee-heavy settlement would make small orders — the ones underserved today —
  uneconomic.
- **USDC is native and liquid.** No bridge, no wrapped asset, no extra trust.
- **Soroban gives enforcement, not just transfer.** Repayment priority,
  authorization and escrow are contract logic, not a convention everyone
  promises to follow.
- **Anchors are the part nobody else has.** Most chains can move a stablecoin.
  Stellar has a standardised, real network of regulated on/off-ramps into local
  currency — which is the only reason this is a product for a factory in Bursa
  rather than a demo for people who already hold crypto.

## Why an Anchor

Without it, Milvance finances suppliers in a currency they cannot spend and
sources capital only from people who already hold stablecoins. SEP-10, SEP-6
and SEP-38 give us authentication, transfer and firm quoted rates against a
provider the user chooses — with KYC and the bank leg staying at that provider,
never with us.

## Shipment and delivery trust

Milvance does not verify the physical world and does not claim to.

What it does is make the human judgement explicit, binding and visible: the
buyer and supplier name an attestor when the order is created, that address is
fixed for the life of the order, and only that address can verify. Evidence is
committed as a SHA-256 hash, so everyone can prove the attestor saw exactly the
document that was submitted, unaltered.

If the two sides disagree, a named resolver decides — per milestone, so one
contested shipment does not freeze the rest of the order.

That is an honest trust model: cryptography for integrity and authorization,
named humans for judgement about physical goods.

## Core separation (do not blur)

```text
Buyer money  = protected milestone payment
Funder money = supplier liquidity now
Soroban      = enforceable shared financial state
Anchor       = local-money edge
```

## Copy guardrails

Avoid unsupported claims: _risk-free_, _trustless physical-world verification_,
_fully regulated_, _guaranteed yield_, _no counterparty risk_, _legally
enforceable receivable assignment without a legal wrapper_, or the idea that a
non-custodial design removes regulatory obligations.

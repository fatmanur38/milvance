# Milvance — Submission

## One line

Milvance is local-payment-powered production finance: a buyer protects a
milestone payment on Soroban instead of prepaying, an independent funder
advances working capital against it, and the contract repays the funder first
out of escrow when the work is verified — with Stellar Anchors connecting it
all to the local currency a factory actually spends.

## The problem

A manufacturer wins a cross-border order and must pay for materials, energy and
wages weeks before they are paid. The buyer will not prepay a counterparty they
cannot enforce against. The supplier cannot start without cash. Trade finance
exists for exactly this gap and reaches large exporters, not the workshop with
forty machines — and when financing does arrive, it often arrives in a currency
the supplier cannot spend.

## The solution

Put the buyer's commitment, the supplier's claim and the funder's repayment
priority in one place all three can verify and none controls.

1. The buyer protects a milestone payment in MilvanceCore. Committed, visible,
   spendable by nobody.
2. The supplier requests financing against it; an independent funder advances
   their own USDC immediately.
3. The supplier converts that advance to local currency through a Stellar
   Anchor and starts production.
4. Evidence is committed as a SHA-256 hash; a named attestor verifies.
5. The contract settles atomically: funder repaid first, supplier gets the
   remainder.

## Why Stellar

- **Cheap, fast finality** — a milestone flow is many small transactions; fees
  decide whether small orders are economic.
- **Native USDC** — no bridge, no wrapped asset, no extra trust.
- **Soroban enforces** repayment priority and authorization, rather than
  everyone agreeing to honour them.
- **Anchors** — the decisive one. Most chains can move a stablecoin. Stellar has
  a standardised network of local-currency on/off-ramps, which is the only
  reason this works for a factory rather than for people who already hold
  crypto.

## Why now

Stablecoin settlement is already normal in cross-border B2B. What is missing is
enforceable structure on top of it: who is owed what, out of which escrow, in
what order. Soroban makes that programmable, and the Anchor network makes it
reach businesses that are paid in their own currency.

## Architecture in five lines

```text
Wallets (Freighter) ──► Soroban MilvanceCore ──► Stellar USDC
                                 │
                        contract events ──► indexer ──► PostgreSQL ──► API ──► web
                                 │
     Anchor (SEP-10/6/38) TRY ⇄ USDC          evidence: bytes off-chain, SHA-256 on-chain
```

Soroban is the financial source of truth. PostgreSQL is a projection that can
be dropped and rebuilt from chain at any time. The backend holds no keys and
signs nothing.

## Track fit

Real Soroban contract logic — escrow, financing, repayment priority,
authorization, dispute resolution — combined with real SEP-10/6/38 Anchor
integration for the local-currency edge, proven end to end on Testnet with
wallet-signed transactions from five separate accounts.

## What is real today

- MilvanceCore deployed on Stellar Testnet: `CCN6AZHL…TKRX`, 180 contract tests
- A complete lifecycle proven live with real wallet signatures: order → protect
  → finance → advance → evidence → verify → settle, and a second milestone
  through dispute → refund
- Real Anchor TRY ⇄ USDC through SEP-10, SEP-38 and SEP-6
- **One complete local-payment finance cycle** — protected, financed, verified,
  settled funder-first, and converted to TRY by the supplier, with the Stellar
  leg confirmed against Horizon rather than merely reported
- An indexer whose PostgreSQL projections are rebuildable and reconciled
  against the contract
- Public metrics where every figure carries its definition and provenance,
  including one reported Anchor leg published as failing its Stellar check

## Known limitations

- **Testnet only**, with test USDC and a mock Anchor that simulates KYC and the
  bank leg.
- **Attestation is human.** Milvance does not verify physical goods and does not
  claim to. The contract enforces _who_ decides, not whether they are right.
- **A refund does not reverse a funder's advance.** The supplier keeps it; the
  funder's remaining claim is off-chain. This is deliberate and documented.
- **An on-chain position is not a legal receivable assignment** without a legal
  wrapper.
- **No external users yet.** Our traction page reports zero external
  participants, because that is the truth.

## Roadmap

1. More Anchor corridors beyond TRY
2. A funder marketplace with risk signals from settled history
3. Legal wrappers so an on-chain position becomes an enforceable receivable
4. Platform integration — sourcing marketplaces that already match buyers and
   suppliers but cannot finance them
5. Mainnet, with regulated Anchors and real KYC

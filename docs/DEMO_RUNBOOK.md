# Milvance — Demo runbook

A five-minute demo, and everything needed to recover if something goes wrong
in front of an audience.

## Before you start

| Check                                           | How                                   |
| ----------------------------------------------- | ------------------------------------- |
| Freighter is on **Testnet**                     | Extension → network selector          |
| All five accounts are imported                  | See the table below                   |
| The app is the public deployment, not localhost | Address bar                           |
| The API is ready                                | `curl https://<api>/api/health/ready` |
| Traction page loads                             | `/app/metrics`                        |

Have the block explorer open in a second tab:
`https://stellar.expert/explorer/testnet/contract/CCN6AZHLN2BQPCDZWXJGA3NRJEJ56V5JK3M4VZ5QFKQ3NSJBN6RVTKRX`

## The cast

| Role     | Address         | Needs                             |
| -------- | --------------- | --------------------------------- |
| Buyer    | `GCKFEDBA…EKHW` | XLM, USDC trustline, USDC balance |
| Supplier | `GBBS3FS2…YHXQ` | XLM, USDC trustline               |
| Funder   | `GBRQHY4M…MVCT` | XLM, USDC trustline, USDC balance |
| Attestor | `GDU5EPX7…RXDH` | XLM only                          |
| Resolver | `GD75QRXB…3NBD` | XLM only                          |

Attestor and resolver never touch money, so they only need XLM for fees.

## Already on chain — use this, do not rebuild it

The full lifecycle has been proven live and is permanently inspectable:

| What                | Where                                                          |
| ------------------- | -------------------------------------------------------------- |
| Order #2, COMPLETED | Both milestones terminal                                       |
| Milestone #2        | Protected 10 USDC → advanced 8 → settled: funder 9, supplier 1 |
| Milestone #3        | Protected 10 USDC → disputed → refunded 10 to the buyer        |
| Order #3            | Created from a Trade Lab template, still open                  |

This is the backup. If a live transaction fails during the demo, switch to
Order #2 and narrate the completed history — every number is real and every
hash is on the explorer.

## The script (5:00)

### 0:00–0:30 — The problem

> "A Turkish manufacturer wins a €50,000 order. Production starts in three
> weeks. They need to pay for fabric, dye and wages — in lira, now. The buyer
> won't prepay someone they can't enforce against. Both sides are stuck."

### 0:30–1:00 — Local money in

**Screen: `/app/anchor`.** Show the TRY → USDC conversion.

> "The capital that funds this starts as local money. This is a Stellar Anchor,
> SEP-10 for auth, SEP-38 for a firm rate, SEP-6 for the transfer. KYC and the
> bank leg stay at the provider — we never see them."

### 1:00–1:35 — The buyer protects a milestone

**Screen: the milestone card, buyer wallet.** Show 10 USDC protected.

> "The buyer is not prepaying. This money is committed to this milestone,
> visible to everyone, and spendable by nobody — including us — until someone
> they chose verifies the work."

Open the explorer on the funding transaction.

### 1:35–2:15 — Financing

**Switch Freighter to the supplier.** The header follows the account on its
own — mention that, it is a real detail.

Show the finance request (8 USDC against the protected 10), then switch to the
**funder**, show the offer (8 → 9), and the advance landing.

> "A funder, independent of all four parties — the contract enforces that —
> advances their own 8 USDC to the supplier right now."

### 2:15–2:30 — The distinction that matters

**Screen: the two money pools, side by side.**

> "Ten USDC protected by the buyer. Eight USDC advanced by the funder. These
> are never added together and never substituted. The buyer's money has not
> moved. If the advance came out of escrow, the buyer would be prepaying after
> all — just with extra steps."

### 2:30–2:55 — Local money out

**Screen: Convert to TRY, from the supplier's advance.**

> "The supplier now has working capital — but a dye house doesn't take USDC.
> Back through the Anchor, into lira. That's when the financing becomes real."

### 2:55–3:30 — Evidence and attestation

**Supplier:** attach the QC report, show the SHA-256, sign.

> "The document stays off-chain. Thirty-two bytes go on chain. That proves the
> attestor read exactly this file, unaltered — it does not prove the file is
> honest, and we don't claim it does."

**Switch to the attestor**, show the matching fingerprint, verify.

### 3:30–3:55 — Settlement

**Screen: settle the milestone.**

> "Funder first: 9 USDC repaid. Supplier gets the remaining 1. One atomic
> transaction, enforced by the contract — not by anyone's goodwill."

Explorer link on the settlement.

### 3:55–4:20 — Dispute isolation

**Screen: milestone #3 on Order #2.**

> "Second milestone, same order. The buyer disputed it, the named resolver
> refunded 10 USDC. Notice the first milestone stayed settled — disputes are
> per milestone, so one contested shipment doesn't freeze the order. And a
> refund does not claw back a funder's advance. We say that plainly, because
> it's the risk the funder is actually taking."

### 4:20–4:40 — Traction

**Screen: `/app/metrics`.**

> "Every number here comes from indexed contract events. Testnet protocol
> activity is separated from external adoption, and external adoption is zero,
> because no one outside the team has used it yet. We'd rather show a zero than
> label our own wallets as traction. Each metric carries its definition and its
> source."

Point at a contradicted Anchor report if one is showing.

> "That's a report whose transaction hash doesn't match what Stellar records.
> We publish it rather than hide it, and it counts towards nothing."

### 4:40–5:00 — Why Stellar, and what's next

> "Cheap finality makes small orders economic. USDC is native. Soroban enforces
> repayment priority instead of everyone promising to honour it. And Anchors
> are the part no other chain has — a real network of local-currency ramps,
> which is why this is a product for a factory in Bursa and not a demo for
> people who already hold crypto.
>
> Next: more Anchor corridors, a funder marketplace, and a legal wrapper so an
> on-chain position becomes an enforceable receivable."

## If something breaks

| Symptom                           | Do this                                                                                                              |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Freighter shows the wrong account | Switch it; the app follows within a few seconds. No reconnect.                                                       |
| "Account not found"               | The wallet is on the wrong network, or the account is unfunded. Check the network selector first.                    |
| Transaction rejected              | Simulation failure is shown with the contract's own reason. Read it aloud — it is usually a guard working correctly. |
| Numbers look stale                | `/api/health/ready` shows indexer lag. Say so; it is a read-model delay, not a chain problem.                        |
| Anchor is slow                    | The mock Anchor is a free sandbox. Switch to the completed Order #2 history.                                         |
| Anything at all                   | Fall back to Order #2 and the explorer. Every transaction is permanent.                                              |

## Rehearsal checklist

- [ ] Run the full script once against the public deployment
- [ ] Run it a second time with a different wallet order to shake out stale state
- [ ] Confirm every explorer link opens
- [ ] Confirm `/app/metrics` matches what you say about it
- [ ] Record a backup video of a successful run

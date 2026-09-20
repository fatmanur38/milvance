# PKG-09 product workspace

The role-aware workspace at `/app` is where buyers, suppliers, funders, attestors
and resolvers actually work. It replaces the single-purpose `/wallet` and
`/anchor` proofs with one place that shows a trade, and the money inside it, to
whoever is looking.

## Routes

| Route              | Purpose                                                              |
| ------------------ | -------------------------------------------------------------------- |
| `/app`             | Overview: what needs this wallet's attention, across every order     |
| `/app/orders`      | Orders this wallet is part of, with its role on each                 |
| `/app/orders/[id]` | One order: parties, milestones, money, evidence, disputes, actions   |
| `/app/funding`     | Open working-capital requests, this funder's offers and positions    |
| `/app/anchor`      | The PKG-07 local-payment flow, reachable in context from a milestone |
| `/app/activity`    | The indexed contract event stream                                    |

## Roles come from the chain, never from the UI

A wallet's role on an order is derived from the addresses the contract records:
buyer, supplier, attestor, resolver. A funder is any wallet that is none of those
four, which is exactly the rule `make_offer` enforces. Address comparison is
exact — no case folding, no truncation. Nobody picks a role in the interface, and
no route grants one: the workspace only shows what a wallet could already do, and
the contract re-checks every action when it is signed.

## Protected money is not the supplier's money

Two amounts exist on a financed milestone and they are never added together:

| Pool                         | Whose money      | Meaning                                             |
| ---------------------------- | ---------------- | --------------------------------------------------- |
| **Protected by buyer**       | the buyer's      | locked in MilvanceCore; the supplier has not got it |
| **Working capital received** | the funder's own | already in the supplier's wallet, theirs to use     |

The supplier-facing captions say so in words: protected money is "not money you
have received", while an advance "is yours to use now". Amounts are integer base
units (7 decimals) in strings and `bigint` end to end; no JavaScript float ever
touches an authoritative amount.

Once a milestone reaches a terminal state the escrow is empty, and the card says
**Currently protected 0.00 USDC** with the historical **Originally protected**
figure taken from the chain's own settlement or refund record. A disputed
milestone shows both possible outcomes rather than only the settle path.

## Every action is the user's signature

The browser builds each call with the generated bindings, simulates it, asks the
wallet to sign, submits it to Stellar RPC and waits for confirmation. The backend
is not in that path and signs nothing. After Stellar confirms, the UI waits for
the indexer to reach that ledger, re-reads the API and only then shows the new
state — "Confirmed on Stellar. Updating workspace…" is a real wait, not a
placeholder. If the indexer lags, the workspace says the transaction is confirmed
and the view is catching up. It never edits its own copy of financial state.

Freighter can switch accounts at any time and cannot notify the page, so the
workspace polls for the active account and network while the tab is visible and
follows a switch on its own. The authoritative checks still run at signing time:
a wrong network or a changed account is refused before a signature is requested.

## Evidence

The browser hashes the document with SHA-256, the API stores the bytes and
re-hashes them, and only the 32-byte fingerprint is committed on chain. Raw bytes
never reach Soroban. The attestor can compare a copy they received against the
commitment locally before verifying. Stellar records who verified and when; it
cannot inspect goods, and the product never pretends otherwise.

## Derived states move no money

`DELAYED` and `NEEDS_REVIEW` are computed for display from deadlines and dispute
state. They are not Soroban milestone states, they are marked as derived in the
interface, and a target date passing has no financial effect whatsoever.

## Live Testnet proof

The full multi-role flow was executed on Stellar Testnet from the browser, by a
human approving every transaction in Freighter. Five independent accounts were
used; no key, seed or signature was ever held by Milvance, and the deployer
identity was not used as a participant.

Order **#2** on `CCN6AZHLN2BQPCDZWXJGA3NRJEJ56V5JK3M4VZ5QFKQ3NSJBN6RVTKRX`, with
two 10 USDC milestones, one financed and settled, one unfinanced and refunded.

| #   | Action                                    | Signer   | Public transaction                                                                                                         |
| --- | ----------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | `create_milestone` (10 USDC)              | buyer    | [`b3cb5557…`](https://stellar.expert/explorer/testnet/tx/b3cb5557ee27d4c0b45a26e4f91623904dd6a469afa7ad052086887f232f0bfb) |
| 2   | `create_milestone` (10 USDC)              | buyer    | [`fbc6c96e…`](https://stellar.expert/explorer/testnet/tx/fbc6c96ea0e12bab8b382e5be84d28cbf9368e636856af8c793af86a876e1a47) |
| 3   | `accept_order`                            | supplier | [`d1c96f76…`](https://stellar.expert/explorer/testnet/tx/d1c96f768264957a1e50f157bc3367081d83ff3a09c5d4f17351cd8d1fa19072) |
| 4   | `fund_milestone` (10 USDC escrowed)       | buyer    | [`40faf6a1…`](https://stellar.expert/explorer/testnet/tx/40faf6a1e0339597ea38a6ff87b33642edf455fcffccf0ac521b0469a7a7c8ec) |
| 5   | `request_finance` (8 USDC, 14 days)       | supplier | [`bbad2fb6…`](https://stellar.expert/explorer/testnet/tx/bbad2fb6bce4a1018b8f01cdbbbf80bfd407c8763d8dd8bd0de6227e2bfac1b8) |
| 6   | `make_offer` (8 → repay 9)                | funder   | [`e7fe643b…`](https://stellar.expert/explorer/testnet/tx/e7fe643b627706b001330e9d816f76d5a375d30fa7c803da80d75edad68c5bcd) |
| 7   | `accept_offer`                            | supplier | [`3d92813b…`](https://stellar.expert/explorer/testnet/tx/3d92813bb840be16d5a69b0c3ddc4a6dbc5886436675e7a26680a649928350bc) |
| 8   | `fund_advance` (8 USDC funder → supplier) | funder   | [`86c67e16…`](https://stellar.expert/explorer/testnet/tx/86c67e161050ad339c242baf3b45db9a4e82c4df60cbf13083e4e506c9c5b52b) |
| 9   | `submit_evidence`                         | supplier | [`e762c139…`](https://stellar.expert/explorer/testnet/tx/e762c1391526446d03dad61c5d2a82619a66147ed8dfc38bda584397dc778fc6) |
| 10  | `attest_milestone`                        | attestor | [`68638b22…`](https://stellar.expert/explorer/testnet/tx/68638b229a2b48553781b1d6ac8d645859ce39e999c9aec01811cd68285ab664) |
| 11  | `settle_milestone` (9 funder, 1 supplier) | funder   | [`2349bf5a…`](https://stellar.expert/explorer/testnet/tx/2349bf5a7ecf355c2f3a489fad035e038fc2e8196c039fcd1e148844fe55c35d) |
| 12  | `fund_milestone` (10 USDC escrowed)       | buyer    | [`64cb171b…`](https://stellar.expert/explorer/testnet/tx/64cb171b80d846a261f7c66adcf9026f2fcde58728c5b495e900cd1d31f838ea) |
| 13  | `open_dispute`                            | buyer    | [`60bf19c8…`](https://stellar.expert/explorer/testnet/tx/60bf19c8911d146e874abaf60ff14879fbc5fa76c8245fb5d0b204226ce154b7) |
| 14  | `resolve_dispute` (Refund)                | resolver | [`d6d3bf75…`](https://stellar.expert/explorer/testnet/tx/d6d3bf75fb4450dd1901f3662689f054792ac00241c4a440d536bf7c1922229f) |

Every transaction was decoded from Stellar RPC and Horizon independently of the
interface: source account, invoked function, arguments, authorisation entries,
the ledger entries it was allowed to write, and its contract events.

**What the money did.** The buyer protected 10 USDC on each milestone. On the
financed one, the funder's own 8 USDC went straight to the supplier — the escrow
was not the source, and the transaction could not touch it. At settlement the
escrow paid the funder 9 USDC first and the supplier the remaining 1 USDC. On the
unfinanced one, the resolver refunded the buyer's 10 USDC in full. Final balances
matched exactly: buyer 40.3960908, supplier 9.0000000, funder 11.0000000,
contract **0.0000000**. Order #2 completed itself once both milestones were
terminal.

**Evidence.** The committed fingerprint was
`4c0d1f743ff764d0958aef159ae7ad7c98f0e9117de30952706a54aac9c8f47d`. The stored
bytes were hashed independently and produced the same digest; the document itself
stayed off-chain and is not part of this repository.

**Account switching.** One person played all five roles. Switching account in
Freighter moved the workspace to the new party on its own, with no reconnect,
proven live for supplier → funder, funder → supplier and supplier → attestor.

**Indexer.** Every event was ingested exactly once with no duplicates, and a full
replay rebuilt the derived state from chain without disturbing off-chain rows.
Chain-to-database reconciliation passes for both orders and all three milestones.

## Bugs found by running it live

Two defects were found during the live proof and fixed in this package.

- **A stale wallet account after switching roles.** The app read the Freighter
  account only at connect, on window focus, or on an explicit refresh. Switching
  account left the workspace on the previous party, so actions were built for the
  wrong address and refused at signing. The workspace now follows account and
  network changes while the tab is visible.
- **Terminal escrow was never zeroed in the read model.** Settlement and refund
  release the milestone's escrow on chain, but the projection left
  `fundedAmount` at its old value. Chain-to-database reconciliation failed, and
  the workspace told the buyer their money was still held by the contract after
  it had been paid out or returned. The projector now records the empty escrow,
  the historical amount lives on the settlement and refund rows, and the card
  distinguishes what is protected now from what was protected.

## Development limits

The evidence store is the local driver from PKG-08; a durable object store needs
deployment credentials. Trade Lab, QR onboarding and the traction dashboard are
later packages and are not implemented here.

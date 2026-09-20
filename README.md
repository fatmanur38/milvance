# Milvance

**Local-payment-powered production finance on Stellar.**

> Milvance converts buyer-protected production milestones into financeable working
> capital and connects that capital to the local currency suppliers actually use.

**Buyer funds the work, not the supplier.**

---

## Try it

|                   |                                                                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Live app**      | _see [Live deployment](#live-deployment)_                                                                                                           |
| **Contract**      | [`CCN6AZHL…TKRX`](https://stellar.expert/explorer/testnet/contract/CCN6AZHLN2BQPCDZWXJGA3NRJEJ56V5JK3M4VZ5QFKQ3NSJBN6RVTKRX) on Stellar **Testnet** |
| **You need**      | [Freighter](https://freighter.app) set to Testnet. Nothing else — no signup, no key shared with us.                                                 |
| **5-minute tour** | [Demo runbook](docs/DEMO_RUNBOOK.md)                                                                                                                |

Everything runs on Testnet with test USDC. No real money moves at any point.

---

## The problem

A cross-border supplier can hold a confirmed order and still be unable to start
production. Wages, materials, energy and local logistics are paid in local currency,
and payment often arrives only after production — or after weeks of sea freight.

The obvious fix, having the buyer prepay the supplier, just moves production and
delivery risk onto the buyer.

## The mechanism

Milvance separates payment protection from working-capital liquidity.

```text
Buyer  ──2,000 USDC──▶  MilvanceCore escrow        (locked, protected, NOT supplier cash)
Funder ──1,400 USDC──▶  Supplier                    (separate capital, spendable now)

Milestone VERIFIED
       ↓
2,000 locked milestone payment
       ├── 1,445 → Funder     (repayment priority)
       └──   555 → Supplier   (remainder)
```

The supplier converts the advance to TRY through a Stellar Anchor and pays for
materials and labour immediately, while the buyer's money stays protected until the
milestone is actually verified.

### Two flows that must never be confused

|                        | Buyer milestone prefunding     | Funder advance                 |
| ---------------------- | ------------------------------ | ------------------------------ |
| Flow                   | Buyer → MilvanceCore escrow    | Funder → Supplier              |
| Capital source         | Buyer                          | Funder's own, separate capital |
| Spendable by supplier? | **No** — locked                | **Yes** — immediately          |
| Released               | On verification, at settlement | At `fund_advance()`            |

Buyer escrow is never the source of the supplier's advance.

## Why Stellar

Remove Soroban and these facts move back into a private platform database: _is the
milestone funded? is a finance request open? who holds repayment priority? was it
already financed? verified? disputed? settled?_ A financing provider would have to
trust the platform's database. Soroban makes that state shared and independently
verifiable.

## Why Anchor

Our users do not live in USDC. A Turkish supplier needs TRY to buy materials and pay
workers. `TRY ↔ Anchor ↔ Stellar USDC` is part of the core economic loop, not an
optional withdrawal button.

## What Milvance does not claim

Soroban cannot independently know that goods were manufactured, loaded, shipped or
delivered. An authorized attestor establishes that. Milvance is not trustless
physical-world verification, and a finance position is not risk-free.

## The five roles

| Role         | Does                                                            | Touches money                                           |
| ------------ | --------------------------------------------------------------- | ------------------------------------------------------- |
| **Buyer**    | Creates the order, protects each milestone payment, can dispute | Yes — into escrow                                       |
| **Supplier** | Accepts the order, requests financing, submits evidence         | Yes — receives the advance and the settlement remainder |
| **Funder**   | Offers financing and advances their own USDC                    | Yes — pays the supplier, is repaid first                |
| **Attestor** | Checks evidence against what was promised and verifies on chain | No                                                      |
| **Resolver** | Decides a disputed milestone: settle or refund                  | No                                                      |

The contract enforces that a funder is independent of all four other parties,
and that only the named attestor and resolver can act in their roles. A role
named in a URL grants nothing — permissions come from the addresses stored on
the order and are re-checked when a transaction is signed.

## Evidence

A supplier's document never goes on chain. The browser hashes the file, the
bytes go to private object storage, and the supplier's **wallet** commits the
32-byte SHA-256 to Soroban. The attestor retrieves the document, sees the
matching fingerprint, and decides.

That proves the attestor read exactly the bytes that were committed. It proves
nothing about whether the document is honest — the attestor's judgement is the
trust boundary, and [the threat model](docs/THREAT_MODEL.md) says so plainly.

## Where the numbers come from

Every figure on the traction page carries its own definition and provenance,
served by the API next to the value:

| Provenance                    | Meaning                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------- |
| **On chain**                  | Projected from MilvanceCore events; rebuildable from Stellar                      |
| **Anchor-reported**           | A provider's word. No blockchain can prove a bank transfer.                       |
| **Reported, Stellar-checked** | A report whose Stellar leg Horizon confirms — asset, direction, wallet and amount |
| **Self-declared**             | A wallet owner's statement about themselves                                       |

Protocol activity includes our own demo wallets and says so. External adoption
counts only wallets whose owners opted in and declared themselves outside the
team — nothing is inferred from behaviour, so that number is honestly zero
until someone outside the team uses Milvance. See [public metrics](docs/METRICS.md).

---

## Repository layout

```text
apps/web                    Next.js wallet proof + future product UI
apps/api                    NestJS read layer + indexer   (PKG-08)
contracts/milvance-core     Soroban financial core        (PKG-01…PKG-04)
packages/shared             Framework-agnostic primitives
packages/stellar            Network config and read helpers
packages/anchor             SEP adapter boundary          (PKG-07)
packages/contract-bindings  Generated TS bindings         (PKG-05)
scripts/                    Deployment, seeding, demo verification
docs/                       Architecture, threat model, runbook, narrative, ADRs
```

## Prerequisites

- Node `>= 20.19` (see `.nvmrc`) and pnpm `10.22`
- Rust stable with the `wasm32v1-none` target
- Stellar CLI `28.x`
- PostgreSQL `14+` for the API read models

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
rustup target add wasm32v1-none
brew install stellar-cli        # or see https://developers.stellar.org
```

## Local setup

```bash
pnpm install
cp .env.example .env
pnpm --filter @milvance/api db:generate
pnpm --filter @milvance/api db:migrate

pnpm lint         # ESLint across the workspace
pnpm typecheck    # tsc --noEmit
pnpm test         # Vitest
pnpm build        # Next.js + tsc builds

pnpm contract:test     # cargo test
pnpm contract:build    # stellar contract build (soroban-sdk 28 requires the CLI)
pnpm verify            # everything above, in order
```

## Configuration

`.env.example` is the environment contract. Copy it to `.env` and fill it in.
Never commit `.env`, a secret key, or an Anchor JWT. Only `NEXT_PUBLIC_*` values
reach the browser.

For PKG-08, run `pnpm --filter @milvance/api indexer once` to backfill the
deployed contract, then `pnpm --filter @milvance/api start` to serve the read API.
The [API read layer guide](docs/API_READ_LAYER.md) covers PostgreSQL setup,
replay, health checks, and evidence metadata. The API never signs a Soroban
transaction; users continue to authorize financial actions in their wallets.

## Security posture

- Stellar/Soroban is the financial source of truth; PostgreSQL is a read model.
- The backend holds no user secret keys and signs no user financial transaction.
- Users authorize their own transactions through Stellar Wallets Kit.
- Raw evidence documents stay off-chain; only a SHA-256 commitment goes on-chain.
- A missed deadline alone never moves funds.

## Deploying it

`Dockerfile`, `render.yaml` and `apps/web/vercel.json` describe the whole
deployment: web on Vercel, API and indexer as two processes from one container
image on Render, managed PostgreSQL, and a **private** S3-compatible bucket for
evidence. No secret is in any of those files.

```bash
pnpm --filter @milvance/api db:migrate   # prisma migrate deploy — never resets
pnpm --filter @milvance/api indexer watch # continuous, exactly one instance
pnpm --filter @milvance/api cycles verify # confirm Anchor legs against Horizon
```

Full instructions, every environment variable, and which ones are secret:
[deployment guide](docs/DEPLOYMENT.md).

## Known limitations

Stated here rather than buried, because a submission that hides these is worse
than one that does not have them:

- **Testnet only.** Test USDC, and a mock Anchor that simulates KYC and the bank
  leg. No real money moves.
- **Attestation is human.** Milvance does not verify physical goods. The
  contract enforces _who_ decides, not whether they decided correctly.
- **A refund does not reverse a funder's advance.** The supplier keeps it; the
  funder's remaining claim is off-chain. The funder takes supplier performance
  risk, and buyer escrow is not a guarantee to them.
- **An on-chain position is not a legal receivable assignment** without a legal
  wrapper in the relevant jurisdictions.
- **Non-custodial does not mean unregulated.** Holding no keys removes custody
  risk, not money-transmission or lending obligations.
- **No external users yet.** The traction page reports zero, because that is
  true.
- **No partial settlement**, no attestor rotation, no appeal beyond the named
  resolver.

## Stellar tooling used

Soroban SDK 28 (Rust) · Stellar CLI 28 · `@stellar/stellar-sdk` 16 · Stellar
Wallets Kit with Freighter · generated contract bindings from the deployed
contract spec · Soroban RPC `getEvents` for indexing · Horizon for payment
verification · SEP-1 discovery, SEP-10 authentication, SEP-38 quotes and SEP-6
transfers for the Anchor · Stellar Asset Contract for USDC.

## Roadmap to submission

| Phase | Package(s)     | Scope                                            | Status  |
| ----- | -------------- | ------------------------------------------------ | ------- |
| 0     | PKG-00         | Repository, tooling, CI, guardrails              | ✅ done |
| 1     | PKG-01…PKG-04  | Soroban financial core                           | ✅ done |
| 2     | PKG-05, PKG-06 | Testnet deployment, Stellar Wallets Kit          | ✅ done |
| 3     | PKG-07         | Anchor / local payments (TRY ↔ USDC)             | ✅ done |
| 4     | PKG-08         | API, PostgreSQL read models, Soroban indexer     | ✅ done |
| 5     | PKG-09…PKG-11  | Product UI, Trade Lab, public traction dashboard | ✅ done |
| 6     | PKG-12         | Hardening, documentation, demo, submission       | ✅ done |

## Documentation

- [Product narrative](docs/PRODUCT_NARRATIVE.md) — the problem, the users, why Stellar
- [Architecture](docs/ARCHITECTURE.md) — how the pieces fit and who is authoritative
- [Threat model](docs/THREAT_MODEL.md) — what is enforced, what is trusted, what is accepted
- [Demo runbook](docs/DEMO_RUNBOOK.md) — the 5-minute script and its recovery paths
- [Deployment](docs/DEPLOYMENT.md) — public deployment, environment, migrations
- [Submission](docs/SUBMISSION.md) — the short version for judges
- [Product workspace](docs/PRODUCT_WORKSPACE.md)
- [Trade Lab](docs/TRADE_LAB.md)
- [Local payments (Anchor)](docs/ANCHOR_LOCAL_PAYMENTS.md)
- [API read layer and indexer](docs/API_READ_LAYER.md)
- [Public metrics](docs/METRICS.md)
- [Architecture decision records](docs/adr/)

## Live deployment

MilvanceCore is deployed on **Stellar Testnet** (`Test SDF Network ; September 2015`).

| Item                                                                                                                                  | Public value                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [MilvanceCore contract](https://stellar.expert/explorer/testnet/contract/CCN6AZHLN2BQPCDZWXJGA3NRJEJ56V5JK3M4VZ5QFKQ3NSJBN6RVTKRX)    | `CCN6AZHLN2BQPCDZWXJGA3NRJEJ56V5JK3M4VZ5QFKQ3NSJBN6RVTKRX`                          |
| Approved USDC issuer                                                                                                                  | `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`                          |
| USDC SAC                                                                                                                              | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`                          |
| [Deployment transaction](https://stellar.expert/explorer/testnet/tx/72cb01b9e681ec2861ce56fecac0fadad9884cc773226b353080d9b1dd69a1b4) | `72cb01b9e681ec2861ce56fecac0fadad9884cc773226b353080d9b1dd69a1b4` (ledger 4760607) |

The [deployment artifact](deployments/testnet.json) includes the WASM hash and
public network metadata. See the [Testnet deployment guide](scripts/deploy-testnet/README.md)
for the repeatable deployment, bindings, and read-only smoke-test commands.

## Wallet proof

Run `pnpm --filter @milvance/web dev`, then open `http://localhost:3000/wallet` in a
browser with Freighter. The page checks the actual wallet network and approved USDC
trustline. A connected buyer can create an empty Testnet order using the generated
MilvanceCore bindings; Freighter signs it, and the page reads the confirmed order
back from the contract. See [wallet layer guide](docs/WALLET_LAYER.md).

**PKG-06 live proof:** A wallet-authorized `create_order` transaction succeeded on
Stellar Testnet in ledger **4,761,475**. The contract emitted `order_created` for
**order #1**, and a separate contract read returned that order with the transaction's
buyer and supplier and the approved USDC SAC. View the
[public transaction](https://stellar.expert/explorer/testnet/tx/5fafed67546e55aa79f441a5fdd5932bd4038bd05e3cc3af4c820e522c5783ee).

## Local payment proof

Open `http://localhost:3000/anchor` to move between Turkish lira and Stellar USDC
through a SEP-6 Anchor. Both directions were run live on Stellar Testnet from the
browser with Freighter signing every transaction:

| Direction  | Quoted                         | Public transaction                                                                                                                            |
| ---------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| TRY → USDC | 1,000.00 TRY → 20.3960908 USDC | [`cc50640a…`](https://stellar.expert/explorer/testnet/tx/cc50640ab6bd9e377e5fedad276186c748d7d92a7b75c15e1aafd5182e1415fa) (ledger 4,763,352) |
| USDC → TRY | 20 USDC → 970.82 TRY           | [`a9f38d19…`](https://stellar.expert/explorer/testnet/tx/a9f38d19afa9c153290799e6e82058b6def395d16688a830c85b93f3563f29c7) (ledger 4,763,239) |

Milvance never holds a key, a seed, or a signature on the user's behalf. See the
[local payments guide](docs/ANCHOR_LOCAL_PAYMENTS.md).

## Multi-role proof

The workspace at `http://localhost:3000/app` shows a trade to whoever is looking:
buyer, supplier, funder, attestor or resolver, derived from the connected wallet
and the addresses on the order.

A complete trade was run live on Stellar Testnet from the browser, with a human
approving all fourteen transactions in Freighter across five separate accounts.
Order #2 carried two 10 USDC milestones:

- **Financed and settled.** The buyer protected 10 USDC. A funder advanced 8 USDC
  of their own money straight to the supplier — not from the buyer's escrow. After
  the attestor verified the evidence, the escrow repaid the funder 9 USDC first
  and paid the supplier the remaining 1 USDC.
- **Unfinanced and refunded.** The buyer protected 10 USDC, opened a dispute, and
  the resolver returned the full amount to the buyer.

The order then completed itself, leaving the contract holding nothing. Every
transaction hash is listed in the [product workspace guide](docs/PRODUCT_WORKSPACE.md),
along with the two bugs the live run exposed and fixed.

## Built for

Stellar Pro Hackathon 2026 — Genesis Track.

## License

[MIT](LICENSE)

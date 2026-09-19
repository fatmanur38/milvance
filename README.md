# Milvance

**Local-payment-powered production finance on Stellar.**

> Milvance converts buyer-protected production milestones into financeable working
> capital and connects that capital to the local currency suppliers actually use.

**Buyer funds the work, not the supplier.**

---

> **Repository status:** The Phase 1 Soroban core is deployed on Stellar Testnet and
> the minimal Freighter wallet surface is available at `/wallet`. Anchor integration,
> backend and full product UI remain later packages — see [Roadmap](#roadmap-to-submission).

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

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
rustup target add wasm32v1-none
brew install stellar-cli        # or see https://developers.stellar.org
```

## Local setup

```bash
pnpm install
cp .env.example .env

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

## Security posture

- Stellar/Soroban is the financial source of truth; PostgreSQL is a read model.
- The backend holds no user secret keys and signs no user financial transaction.
- Users authorize their own transactions through Stellar Wallets Kit.
- Raw evidence documents stay off-chain; only a SHA-256 commitment goes on-chain.
- A missed deadline alone never moves funds.

## Roadmap to submission

| Phase | Package(s)     | Scope                                            | Status  |
| ----- | -------------- | ------------------------------------------------ | ------- |
| 0     | PKG-00         | Repository, tooling, CI, guardrails              | ✅ done |
| 1     | PKG-01…PKG-04  | Soroban financial core                           | ✅ done |
| 2     | PKG-05, PKG-06 | Testnet deployment, Stellar Wallets Kit          | ✅ done |
| 3     | PKG-07         | Anchor / local payments (TRY ↔ USDC)             | ✅ done |
| 4     | PKG-08         | API, PostgreSQL read models, Soroban indexer     | ⬜ next |
| 5     | PKG-09…PKG-11  | Product UI, Trade Lab, public traction dashboard | ⬜      |
| 6     | PKG-12         | Hardening, documentation, demo, submission       | ⬜      |

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — _TBD_
- [Threat model](docs/THREAT_MODEL.md) — _TBD_
- [Demo runbook](docs/DEMO_RUNBOOK.md) — _TBD_
- [Product narrative](docs/PRODUCT_NARRATIVE.md) — _TBD_
- [Local payments (Anchor)](docs/ANCHOR_LOCAL_PAYMENTS.md)
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

## Built for

Stellar Pro Hackathon 2026 — Genesis Track.

## License

[MIT](LICENSE)

# Milvance — Architecture

Milvance is a local-payment-powered production finance layer. A buyer protects
a milestone payment on Soroban instead of prepaying the supplier; an
independent funder can advance working capital against that protected
milestone; the contract repays the funder first out of escrow when the work is
verified; and Stellar Anchors connect the whole thing to the local currency a
factory actually spends.

## The one diagram

```text
        Buyer        Supplier       Funder      Attestor     Resolver
          │              │             │            │            │
          └──────────────┴──────┬──────┴────────────┴────────────┘
                                │   each signs their own actions
                        Stellar Wallets Kit  (Freighter)
                                │
                                ▼
        ┌───────────────────────────────────────────────────┐
        │   Soroban — MilvanceCore                          │
        │   CCN6AZHL…TKRX on Stellar Testnet                │
        │                                                   │
        │   FINANCIAL SOURCE OF TRUTH                       │
        │   · buyer escrow, held per milestone              │
        │   · finance requests, offers, positions           │
        │   · evidence commitment (SHA-256 only)            │
        │   · settlement: funder first, supplier remainder  │
        │   · disputes, resolved per milestone              │
        └───────────────┬───────────────────┬───────────────┘
                        │                   │
                Stellar USDC          contract events
                (test issuer)                │
                        │                    ▼
        ┌───────────────┴────────┐   ┌───────────────────┐
        │  Anchor / SEP-6,10,38  │   │  Indexer (worker) │
        │  tr-mock-anchor        │   │  cursor + replay  │
        │  TRY ⇄ USDC            │   └─────────┬─────────┘
        │  LOCAL-MONEY EDGE      │             ▼
        └────────────────────────┘   ┌───────────────────┐
                                     │  PostgreSQL       │
                                     │  READ MODELS      │
                                     │  derived, dropped │
                                     │  and rebuilt at   │
                                     │  will             │
                                     └─────────┬─────────┘
                                               ▼
                                     ┌───────────────────┐
        Evidence documents           │  API (read-only   │
        ┌──────────────────┐         │  for chain state) │
        │ object storage   │◀────────┤  /api/orders      │
        │ private bucket   │         │  /api/funding     │
        │ RAW BYTES ONLY   │         │  /api/evidence    │
        │ OFF-CHAIN        │         │  /api/metrics     │
        └──────────────────┘         └─────────┬─────────┘
             only SHA-256                      ▼
             reaches Soroban          ┌───────────────────┐
                                      │  Web app (Next)   │
                                      │  workspace,       │
                                      │  Trade Lab,       │
                                      │  traction         │
                                      └───────────────────┘
```

## Who is authoritative for what

| Layer                       | Authoritative for                                          | Never                      |
| --------------------------- | ---------------------------------------------------------- | -------------------------- |
| **Soroban MilvanceCore**    | Every balance, every state transition, every authorization | —                          |
| **Stellar USDC**            | The asset that actually moves                              | —                          |
| **Anchor / SEP**            | The local-currency edge (TRY ⇄ USDC)                       | A source of on-chain truth |
| **Wallets Kit / Freighter** | User authorization                                         | Held by Milvance           |
| **Indexer**                 | Turning events into rows, exactly once                     | Inventing state            |
| **PostgreSQL**              | Fast reads, off-chain metadata, analytics                  | A balance ledger           |
| **API**                     | Serving projections and off-chain metadata                 | Signing anything           |
| **Object storage**          | Evidence bytes                                             | Public by default          |
| **Web app**                 | Explaining and assembling transactions                     | Holding a key              |

The direction of that table matters more than any individual row: **everything
below Soroban is derived.** Delete PostgreSQL entirely and `indexer replay`
rebuilds it from the chain. No balance, no position and no settlement exists
because a row says so.

## The two money pools, kept apart

This is the single most important thing to understand about Milvance, and the
codebase keeps it separate everywhere — in the contract, in the read model, in
the API and in the UI.

```text
BUYER ESCROW                          FUNDER ADVANCE
protected milestone payment           supplier liquidity, now
      │                                      │
 buyer ──► MilvanceCore              funder ──► supplier
      │    (held, not spent)                  (paid immediately,
      │                                        never from escrow)
      │                                      │
      └──────────► on verification ◄─────────┘
                        │
              ┌─────────┴──────────┐
              ▼                    ▼
      funder repaid first   supplier receives
      (exact repayment)     the remainder
```

They are never added together, never displayed as one number, and never
substituted for one another. A refund returns escrow to the buyer and does
**not** reverse the advance — see the [threat model](THREAT_MODEL.md).

## Lifecycle

```text
create_order ──► accept_order ──► create_milestone ──► fund_milestone
                                                             │
                             ┌───────────────────────────────┤
                             │ (optional financing)          │
                    request_finance                          │
                             │                               │
                       make_offer                            │
                             │                               │
                     accept_offer                            │
                             │                               │
                    fund_advance ──► supplier has USDC now   │
                             │       └─► Anchor ─► TRY       │
                             └───────────────────────────────┤
                                                             ▼
                                                    submit_evidence
                                                             │
                                                  verify_milestone
                                                             │
                                          ┌──────────────────┴─────────┐
                                          ▼                            ▼
                                  settle_milestone              open_dispute
                                  funder first,                        │
                                  supplier remainder          resolve_dispute
                                                              ┌────────┴────────┐
                                                              ▼                 ▼
                                                          Settle            Refund
                                                      (back to VERIFIED)  (escrow to buyer,
                                                                           advance not reversed)
```

## Evidence

```text
supplier's file
      │
      ├─► browser computes SHA-256 ──► supplier's WALLET signs submit_evidence
      │                                          │
      │                                          ▼
      │                                    32 bytes on Soroban
      │                                    (the commitment, nothing else)
      │
      └─► bytes ──► API ──► private object storage
                              │
                     attestor retrieves, reads, decides
```

The chain never sees a filename, a URL or a document. It sees 32 bytes. That
proves the attestor read exactly the bytes that were committed; it proves
nothing about whether the document is honest.

## Deployment shape

```text
Vercel                Render                       Render              Cloudflare R2
┌──────────┐   HTTPS  ┌──────────────┐   TCP   ┌──────────────┐        ┌─────────┐
│ Next.js  │ ───────► │ NestJS API   │ ──────► │ managed      │ ◄───── │ private │
│ web app  │          │ (container)  │         │ PostgreSQL   │        │ bucket  │
└──────────┘          └──────────────┘         └──────▲───────┘        └─────────┘
     │                                                │                      ▲
     │ browser talks directly to:                     │                      │
     ├─► Freighter (extension)              ┌─────────┴────────┐             │
     ├─► Stellar RPC / Horizon              │ indexer worker   │             │
     └─► Anchor (SEP-10/6/38)               │ exactly 1 instance│            │
                                            └─────────▲────────┘             │
                                                      │                      │
                                            Stellar Testnet RPC       API only —
                                            MilvanceCore events       never public
```

Deployment details, environment variables and the migration command are in
[DEPLOYMENT.md](DEPLOYMENT.md).

### When there is no always-on worker

The free hackathon deployment cannot run that worker: its host has no free
background process. So the indexer runs as a **tick** instead — a bounded unit
of the same work, called once a minute by an external scheduler.

```text
Supabase Cron ──► POST /api/internal/indexer/tick ──► the same ingestion code
   every 60s          bearer secret, no body              the worker runs
```

What changes is _when_ indexing runs. What does not change is anything that
makes it trustworthy:

- the same projector, the same cursor, the same transaction boundaries
- one writer at a time, enforced by a lease on the stream rather than by there
  being only one process
- a tick that hits a limit reports `caughtUp: false` and stops; it never skips
  an event to finish sooner, and the cursor never moves past something that
  was not stored

The read model can therefore be up to a minute behind chain, which
`/api/health/ready` reports as degraded rather than hiding. Nothing financial
depends on it: Soroban is still the truth, and the database is still something
you can delete.

See [FREE_HACKATHON_DEPLOYMENT.md](FREE_HACKATHON_DEPLOYMENT.md).

## Further reading

| Document                                        | Covers                                           |
| ----------------------------------------------- | ------------------------------------------------ |
| [API read layer and indexer](API_READ_LAYER.md) | Event ingestion, cursor, replay, reconciliation  |
| [Wallet layer](WALLET_LAYER.md)                 | Authorization, account switching, network guards |
| [Local payments](ANCHOR_LOCAL_PAYMENTS.md)      | SEP-10/6/38 flow and the mock Anchor             |
| [Product workspace](PRODUCT_WORKSPACE.md)       | Role-aware UI and transaction lifecycle          |
| [Trade Lab](TRADE_LAB.md)                       | Templates, invites, QR, demo progress            |
| [Public metrics](METRICS.md)                    | Every metric's definition and provenance         |
| [Threat model](THREAT_MODEL.md)                 | Trust boundaries and accepted risks              |
| [ADRs](adr/)                                    | Decisions and why they were made                 |

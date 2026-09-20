# PKG-08 — API read layer and Soroban event indexer

## Authority boundary

Soroban is the financial source of truth. A user signs every financial action in
their wallet. The NestJS API holds no user key and has no route that funds,
settles, refunds, or otherwise mutates contract state. PostgreSQL contains
rebuildable chain projections, public-safe event metadata, evidence pointers,
and self-reported Anchor transfer metadata. Buyer escrow and a funder's
separate advance remain distinct in both schema and API responses.

```text
MilvanceCore on Stellar Testnet
  → getEvents RPC stream
  → transactional indexer (raw event + projection + daily metric + cursor)
  → PostgreSQL read models
  → read API
```

## Start locally

Use PostgreSQL 14 or newer. Create an empty database and set `DATABASE_URL`
locally to its connection URL. Keep credentials in the process environment or
an ignored `.env`, never in source or a shell transcript. The required public
Testnet contract and USDC values are in `.env.example`.

```bash
pnpm install --frozen-lockfile        # also runs `prisma generate` (postinstall)
pnpm --filter @milvance/api db:migrate
pnpm --filter @milvance/api build
pnpm --filter @milvance/api indexer once
pnpm --filter @milvance/api start
```

`indexer once` paginates until the RPC reports no more events. `indexer watch`
keeps polling; run one worker normally. Two workers are safe because a
PostgreSQL cursor row lock serializes page commits, and a worker with a stale
checkpoint refetches before applying anything. `indexer status` prints the
durable checkpoint. The default start ledger is deployment ledger **4,760,607**.
Set `INDEXER_START_LEDGER` only when initializing a new stream with a verified
earlier boundary.

The indexer stores every accepted event with its RPC ID, ledger, transaction
hash, event index, decoded fields, and original topic/value XDR. Unique indexes
on both RPC event ID and ledger/transaction/event index prevent duplicate
storage. Each page's raw rows, projections, metrics, and cursor update commit
in one database transaction. An undecodable or unprojectable event rolls the
page back. If RPC retention no longer includes required history, indexing stops
with a visible error; it never moves the start ledger forward across a gap.

Projection fails closed rather than guessing. A known event whose prerequisite
row is missing (an order, milestone, offer, finance request or dispute) aborts
the page. So does a financial disagreement with the chain: a settlement that
repays a funder with no active position, or a refund whose reported outstanding
advance does not match the positions it closes. Every contract event name has
an explicit projection, enforced at compile time. A successful event this build
cannot project — for example one emitted by a newer contract — is stored for
audit, and `GET /health/ready` reports the indexer as `degraded` until it is
handled. Events from reverted calls are stored but never projected.

### RPC retention

Public Stellar RPC only serves recent history — about seven days on Testnet at
the time of writing. MilvanceCore was deployed at ledger 4,760,607 on
2026-09-19, so a **fresh** database can backfill from the public RPC only until
that ledger ages out (roughly 2026-09-26). An existing database keeps resuming
from its cursor as long as the worker runs at least once inside the retention
window. After either limit is crossed the indexer stops with an explicit
"outside RPC retention" error and readiness reports `degraded`; point
`STELLAR_RPC_URL` at an archival RPC to backfill. It never skips missing history.

To rebuild chain-derived state, stop the worker and run:

```bash
pnpm --filter @milvance/api indexer replay
```

Replay deletes indexed events, chain projections, and derived daily counters,
then backfills from the configured first ledger. It preserves off-chain
`EvidenceObject`, `AnchorTransaction`, and `DemoParticipant` metadata. Evidence
anchoring flags are rebuilt from chain events. Replay needs an RPC source that
still retains the full history; otherwise use an archival source.

## API

All routes have the `/api` prefix. The principal reads are `GET /orders`,
`/orders/:id`, `/orders/:id/milestones`, `/milestones/:id`,
`/milestones/:id/finance`, `/milestones/:id/evidence`,
`/milestones/:id/disputes`, `/funding/opportunities`, `/funding/positions`,
`/activity`, and `/metrics/public`. `GET /reconcile/orders/:id` and
`/reconcile/milestones/:id` simulate contract getters and compare them with
PostgreSQL; they never patch a mismatch. Chain IDs and amounts leave the API as
decimal strings, preserving `u64` and `i128` precision.

`GET /health` is process liveness. `GET /health/ready` separately checks
PostgreSQL, Stellar RPC, and indexer lag/errors. `GET /indexer/status` reports
the persisted cursor and chain head. HTTP responses include `X-Request-ID`;
request logs include method, path without query values, status, and request ID.
Unexpected errors return a generic response, with credential-shaped text
redacted from operator logs.

`POST /evidence` accepts base64 document bytes and optional expected SHA-256
digest. It enforces the decoded size limit, checks canonical base64, hashes the
actual bytes, and writes them through the `EvidenceStorage` boundary. The
development driver stores bytes under a digest-derived key in
`.evidence-store/`; PostgreSQL stores metadata and the key only. The supplier
must separately sign `submit_evidence(hash)` in a wallet. Only an indexed
`evidence_submitted` event marks matching metadata as anchored. A digest is a
commitment to bytes, not proof that a shipment or document claim is true.
The current commitment is linked per milestone, so reusing a document for two
milestones or replacing a submission does not overwrite another milestone's
evidence view.

`POST /local-payments` records public-safe, self-reported Anchor metadata using
an Anchor transaction ID as an idempotency key. It rejects JWT, seed, private
key, KYC, and bank fields. It neither runs SEP-10 nor signs a transfer. A
browser report is never counted as a completed local-payment finance cycle;
the `LocalPaymentCycleReadModel` requires independent verification before its
`VERIFIED` status may enter public metrics. `DemoParticipant` likewise records
consent metadata, not financial actions. The daily counters for orders,
funding, advances, settlements, refunds, and disputes derive only from
successfully projected contract events. No traction claim is made from an
unverified form submission.

`DELAYED` and `NEEDS_REVIEW` are computed when responses are serialized. They
are never written as Soroban milestone states. A deadline passing alone moves
no money.

Settlement and refund empty a milestone's escrow on chain, so the projection
records `fundedAmount` as zero for `SETTLED` and `REFUNDED` milestones. What was
protected is preserved on the settlement and refund rows. PKG-09 found this
divergence on live Testnet data: the read model kept the pre-release amount, so
reconciliation failed and the workspace claimed money was still held by the
contract after it had been paid out.

## Live Testnet verification

This section records the contract as it stood at the PKG-08 backfill. The
contract has emitted further events since: the PKG-09 browser proof added an
unfunded milestone 1 to order #1 (`milestone_created`, ledger **4,765,836**,
transaction
[`216c40a2…`](https://stellar.expert/explorer/testnet/tx/216c40a2b1494e58466366c926ba0020d83d91640306dc876139663fdb322509)).
The event and order counts below are correct for that earlier point, not for
the live contract today.

PKG-08 backfilled the deployed contract
`CCN6AZHLN2BQPCDZWXJGA3NRJEJ56V5JK3M4VZ5QFKQ3NSJBN6RVTKRX` from
ledger **4,760,607**. The two observed public events were `order_created` for
order **#1** in transaction
[`5fafed67…`](https://stellar.expert/explorer/testnet/tx/5fafed67546e55aa79f441a5fdd5932bd4038bd05e3cc3af4c820e522c5783ee)
at ledger **4,761,475**, and `order_created` for order **#2** in transaction
[`dc27e155…`](https://stellar.expert/explorer/testnet/tx/dc27e15520470911e5e184f09d50100d0ef26cceac6fdbe0d3968973e8db6f74)
at ledger **4,763,172**. `GET /reconcile/orders/1` matched order ID, buyer,
supplier, attestor, resolver, settlement asset, and `CREATED` status with the
live contract. No backend transaction was submitted.

The proof was reproduced independently from an empty PostgreSQL database:

- All four committed migrations applied in order, and `prisma migrate diff`
  against `schema.prisma` was empty.
- One indexer run ingested exactly the two events the RPC returns for the
  contract, with their real RPC IDs, ledgers and transaction hashes, and
  projected two orders and an `ordersCreated` metric of two. `order_count` on
  the live contract is also two.
- `GET /reconcile/orders/1` and `/reconcile/orders/2` both matched every
  compared field against the live contract.
- Two further indexer processes each resumed from the persisted cursor and
  ingested zero events with zero duplicates. Event, order and metric counts did
  not change.
- `indexer replay` rebuilt the derived state from chain. A fingerprint of every
  event row (ID, name, ledger, transaction, projected flag) and every order row
  (all fields) was identical before and after. Off-chain `AnchorTransaction`
  and `EvidenceObject` rows survived with their original row IDs.
- `GET /health/ready` reported PostgreSQL, RPC and indexer `ok` before and
  after the replay.

The live proof uses Stellar Testnet, the approved USDC issuer
`GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`, and its
SAC `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`.

## Development limits

The `local-dev` evidence driver writes to a directory and is intended for local
operation only, because a container's disk does not survive a redeploy. A
durable `s3` driver ships alongside it and works against any S3-compatible
bucket; it needs deployment credentials, so it is off by default. See
[deployment](DEPLOYMENT.md) for the five variables it requires.

Browser-reported Anchor records start as unverified metadata. They become
evidence only when the Stellar side of the report is checked against Horizon —
asset, direction, wallet and exact amount — which
`pnpm --filter @milvance/api cycles verify` performs. A report that fails is
recorded as `MISMATCHED` with its reason and supports no metric. Only a
confirmed leg can close a local-payment finance cycle; see
[public metrics](METRICS.md) for the current figures and what they mean.

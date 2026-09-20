# Milvance — Deployment

Four things have to run for Milvance to be publicly testable, plus two that
already exist and are not ours to deploy.

| Component        | Where                                          | Why there                                                                    |
| ---------------- | ---------------------------------------------- | ---------------------------------------------------------------------------- |
| Web app          | Vercel                                         | Next.js, and the browser talks directly to Freighter, Stellar and the Anchor |
| API              | Render (Docker)                                | Long-lived process next to the database                                      |
| Indexer          | Render worker (same image)                     | Must run continuously; must be exactly one instance                          |
| PostgreSQL       | Render managed                                 | Derived state, but it has to survive a redeploy                              |
| Evidence storage | Cloudflare R2 (or any S3-compatible bucket)    | Documents must survive a redeploy; must be private                           |
| MilvanceCore     | Stellar Testnet — **already deployed**         | `CCN6AZHLN2BQPCDZWXJGA3NRJEJ56V5JK3M4VZ5QFKQ3NSJBN6RVTKRX`                   |
| Anchor           | `tr-mock-anchor.fly.dev` — **already running** | The hackathon sandbox Anchor                                                 |

The contract is not redeployed. It is finished, tested and live; redeploying it
would orphan every transaction the demo depends on.

## Repository files

| File                   | Purpose                                                    |
| ---------------------- | ---------------------------------------------------------- |
| `Dockerfile`           | One image, two commands: API and indexer                   |
| `render.yaml`          | Blueprint for the API, the indexer worker and the database |
| `apps/web/vercel.json` | Build command and security headers for the web app         |
| `.env.example`         | Every variable, with which ones are secret                 |

**No secret is in any of them.** Values marked `sync: false` in `render.yaml`
are typed once into the provider's dashboard.

## Order of operations

Deploy back to front, because each layer needs the URL of the one below it.

### 1. Object storage

Create a **private** bucket (R2, S3, or MinIO) and an access key scoped to it.
Nothing about the bucket may be public: evidence documents are retrieved
through the API, which is the only thing holding these credentials.

Note the endpoint, bucket name, access key id and secret.

### 2. Database, API and indexer

From the Render dashboard, create a Blueprint from this repository. It reads
`render.yaml` and provisions the managed Postgres, the API web service and the
indexer worker.

Then fill in the values marked `sync: false`:

| Variable                    | Service | Value                                                   |
| --------------------------- | ------- | ------------------------------------------------------- |
| `WEB_URL`                   | API     | The public web origin. Set after step 3, then redeploy. |
| `OBJECT_STORAGE_ENDPOINT`   | API     | From step 1                                             |
| `OBJECT_STORAGE_BUCKET`     | API     | From step 1                                             |
| `OBJECT_STORAGE_ACCESS_KEY` | API     | From step 1                                             |
| `OBJECT_STORAGE_SECRET_KEY` | API     | From step 1                                             |

Migrations run automatically before each deploy:

```bash
pnpm --filter @milvance/api db:migrate   # prisma migrate deploy
```

`migrate deploy` only applies pending migrations. It never resets, never drops
and never seeds. There is no code path in this repository that writes a
financial row by hand.

The indexer worker runs `indexer watch` and **must stay at one instance**. Two
workers advancing one cursor is the only way this design can double-count.

### 3. Web app

Import the repository into Vercel with the root directory set to `apps/web`
(`vercel.json` supplies the build and install commands). Set:

| Variable                           | Value                                                             |
| ---------------------------------- | ----------------------------------------------------------------- |
| `NEXT_PUBLIC_API_URL`              | The API URL from step 2, e.g. `https://milvance-api.onrender.com` |
| `NEXT_PUBLIC_TRADE_LAB_ORIGIN`     | The public web origin, once Vercel assigns it                     |
| `NEXT_PUBLIC_ANCHOR_HOME_DOMAIN`   | `tr-mock-anchor.fly.dev`                                          |
| `NEXT_PUBLIC_ANCHOR_MOCK_MODE`     | `true`                                                            |
| `NEXT_PUBLIC_STELLAR_NETWORK`      | `testnet`                                                         |
| `NEXT_PUBLIC_MILVANCE_CONTRACT_ID` | `CCN6AZHLN2BQPCDZWXJGA3NRJEJ56V5JK3M4VZ5QFKQ3NSJBN6RVTKRX`        |

`NEXT_PUBLIC_TRADE_LAB_ORIGIN` matters more than it looks: without it, invite
links and QR codes carry whatever origin the browser is on. A QR containing
`localhost` resolves to the phone that scanned it.

### 4. Point the API at the web app

Set `WEB_URL` on the API to the public web origin and redeploy. CORS accepts
only the origins listed there — a wildcard is impossible, and a preview
deployment can be added with a comma.

## Health checks

From any machine, not just the one that deployed it:

```bash
curl https://<api>/api/health            # process is up
curl https://<api>/api/health/ready      # database reachable, indexer current
curl https://<api>/api/metrics/public    # read models answering
curl -I https://<web>/app                # web app serving
```

`ready` is the interesting one: it fails when the database is unreachable or
the indexer has fallen behind, which is exactly when the UI would otherwise
show stale numbers without saying so.

## Verifying local-payment legs

Anchor reports are recorded automatically by the browser flow, but a report is
a claim. Confirming it against Horizon is a deliberate step:

```bash
pnpm --filter @milvance/api cycles verify    # check new reports, rebuild cycles
pnpm --filter @milvance/api cycles status    # show cycles without writing
```

Run it from a shell with the production `DATABASE_URL`, or as a one-off job on
the API service. Serving metrics never needs it: an unchecked leg simply
supports no completed cycle.

## Rebuilding the read models

PostgreSQL is derived. If it is ever wrong, or you want to prove it is
disposable:

```bash
pnpm --filter @milvance/api indexer replay
pnpm --filter @milvance/api cycles derive
```

`replay` drops the chain-derived tables and rebuilds them from Stellar. Anchor
reports and their verdicts are off-chain metadata and survive; `cycles derive`
then rebuilds cycles from the stored verdicts without touching the network.

One caveat, documented rather than hidden: public Testnet RPC retains a limited
window of event history. A rebuild started long after the deployment ledger
`4760607` has aged out cannot backfill from RPC alone. The indexer detects this
and refuses, rather than quietly starting from "now" and reporting a smaller
history as if it were the whole one.

## What is deliberately absent

There is no signing key, no wallet seed and no Anchor token in any deployment
configuration. The backend has nothing to sign with, by construction. If a
deployment ever seems to need one, something has gone wrong in the design, not
in the configuration.

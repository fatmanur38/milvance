# Deploying Milvance for $0

This assumes you can use a browser and a terminal, and nothing else.

Everything here runs on free tiers. Nothing about the product changes to
achieve that — Soroban is still the financial source of truth, the backend
still signs nothing, and PostgreSQL is still a read model that can be thrown
away and rebuilt from chain.

## What you are building

```text
        Vercel Hobby                Render free web service
        Next.js web  ────────────►  NestJS API + bounded indexer ticks
                                       │          ▲
                                       │          │  POST /api/internal/indexer/tick
                                       │          │  every 60 seconds
          Stellar Testnet  ◄───────────┤          │
          (financial truth)            │     Supabase Cron
                                       ▼
                              Supabase free tier
                              PostgreSQL + private Storage
```

Four accounts, no card: **Supabase**, **Render**, **Vercel**, and the Stellar
Testnet contract that already exists.

## The one architectural difference

Everywhere else, Milvance runs the indexer as a process that polls forever.
Render's free tier has no background worker, so here the indexer runs as a
**tick**: a bounded unit of the same work, called once a minute by Supabase
Cron.

It is the same ingestion code, the same projector and the same transaction
boundaries — `indexer.main.ts watch` still exists and still works. Only the
thing that decides _when_ to run is different.

Two properties make that substitution safe, and both are covered by tests:

- **One writer.** A tick takes a lease on the stream before it starts. A cron
  firing on top of a running tick is told `already_running` and does nothing.
  A tick whose process dies leaves a lease that expires on its own.
- **Stopping early is never skipping.** A tick stops at a page, event or time
  limit and reports `caughtUp: false`. The cursor only ever advances over
  events that were actually stored, so the next tick resumes exactly there.

## Before you start

You will be moving three secrets between dashboards. None of them ever goes
into the repository, a screenshot, or a chat message:

| Secret                | Lives in                            | Read by                  |
| --------------------- | ----------------------------------- | ------------------------ |
| `DATABASE_URL`        | Render environment                  | the API only             |
| `INDEXER_CRON_SECRET` | Render environment + Supabase Vault | the API and the cron job |
| Storage S3 keys       | Render environment                  | the API only             |

None may ever be prefixed `NEXT_PUBLIC_`. That prefix means "compile this into
the browser bundle", which for any of the above means publishing it.

---

## 1. Create a Supabase project

supabase.com → **New project**. Choose a region near your judges and set a
database password when asked — Supabase generates the connection string from
it. Free tier, no card.

Wait for it to finish provisioning before continuing.

## 2. Create a private Storage bucket

**Storage → New bucket**, name it `milvance-evidence`.

**Leave "Public bucket" OFF.** Evidence documents are commercial paperwork. The
chain stores only their SHA-256; the bytes are retrieved through the Milvance
API, which is the only thing holding storage credentials. A public bucket here
would publish every document a supplier uploads.

## 3. Enable the S3 protocol

**Storage → Settings → S3 Connection**. Note two things:

- the **endpoint**, which looks like
  `https://<project-ref>.storage.supabase.co/storage/v1/s3`
- the **region**, e.g. `eu-central-1`

The endpoint has a path, not just a host. Copy all of it.

## 4. Create S3 access keys

Same page → **New access key**. Description: `milvance-api`.

You get an access key id and a secret, shown **once**. Put them somewhere safe
for the next ten minutes — you will paste them into Render in step 8.

These keys can bypass Storage's row-level security. Treat them exactly like a
database password: server-side only, never in the browser, never committed.

## 5. Copy the Session pooler connection string

**Connect** (top bar) → **Session pooler** → copy the URI.

Use that one specifically. The session pooler speaks the normal PostgreSQL
protocol on a host that does not require IPv6, which is what Render's free tier
can reach and what Prisma's migration engine needs.

Replace `[YOUR-PASSWORD]` in the string with the database password from step 1.

Do not commit it. Do not paste it into a chat.

## 6. Apply the migrations

From a clone of this repository, on the `deploy/free-hackathon` branch:

```bash
pnpm install --frozen-lockfile
cd apps/api
DATABASE_URL='<the session pooler string>' pnpm exec prisma migrate deploy
```

`migrate deploy` only applies pending migrations. It never resets, never drops
and never seeds. **Never run `prisma migrate reset` against a deployed
database** — there is no confirmation step that will save you.

The database is now empty of financial data, which is correct. It fills up in
step 12 by reading Stellar, not by being seeded.

Free-tier Render services have no pre-deploy hook, so this step is yours to
repeat whenever a future migration is added.

## 7. Deploy the API to Render

render.com → **New → Blueprint** → connect this repository → branch
`deploy/free-hackathon`. It reads [`render.yaml`](../render.yaml) and proposes
**one** free web service, `milvance-api`.

Confirm that is all it proposes. No database, no worker: this blueprint has
neither, and adding one would leave the free tier.

## 8. Enter the server environment variables

Render will prompt for the values marked `sync: false`:

| Variable                    | Value                                                     |
| --------------------------- | --------------------------------------------------------- |
| `DATABASE_URL`              | the session pooler string from step 5                     |
| `WEB_URL`                   | leave as a placeholder for now — step 15 sets it properly |
| `OBJECT_STORAGE_ENDPOINT`   | the S3 endpoint from step 3, path included                |
| `OBJECT_STORAGE_BUCKET`     | `milvance-evidence`                                       |
| `OBJECT_STORAGE_REGION`     | the region from step 3 — the real one, not `auto`         |
| `OBJECT_STORAGE_ACCESS_KEY` | the access key id from step 4                             |
| `OBJECT_STORAGE_SECRET_KEY` | the secret from step 4                                    |

`INDEXER_CRON_SECRET` is generated by Render, so nobody has to invent one.

If the API starts without every storage value, it refuses to boot and names the
variable that is missing — deliberately, because a storage misconfiguration
discovered mid-demo is worse than one discovered at deploy time. It never
prints the value of anything.

Wait for the first deploy, then check:

```bash
curl -s https://<your-api>.onrender.com/api/health/live
```

## 9. Read the generated cron secret

Render dashboard → `milvance-api` → **Environment** → `INDEXER_CRON_SECRET` →
reveal, copy.

## 10. Store it in Supabase Vault

Supabase → **SQL Editor**, run these two statements (and do not save them into
a file):

```sql
select vault.create_secret('https://<your-api>.onrender.com', 'milvance_api_url');
select vault.create_secret('<the INDEXER_CRON_SECRET>', 'milvance_indexer_cron_secret');
```

The scheduled job reads these by name at run time, which is why no secret
appears in any committed SQL. To rotate later, update the Vault secret and the
Render variable; the job needs no change.

## 11. Schedule the tick

Run [`deploy/supabase/install-indexer-cron.sql`](../deploy/supabase/install-indexer-cron.sql)
in the SQL editor. It enables `pg_cron` and `pg_net` and schedules
`milvance-indexer-tick` every minute.

Confirm it ran:

```sql
select status, return_message, start_time
  from cron.job_run_details
 where jobid = (select jobid from cron.job where jobname = 'milvance-indexer-tick')
 order by start_time desc limit 5;

select status_code, content::text from net._http_response order by created desc limit 5;
```

A healthy response is `{"status":"ran", ... }`. `already_running` is normal
during the backfill. **401 means** the Vault secret and the Render variable
have drifted apart — fix the Vault copy, not the endpoint.

To remove it again:
[`deploy/supabase/remove-indexer-cron.sql`](../deploy/supabase/remove-indexer-cron.sql).

## 12. Let it backfill

The first tick starts at ledger `4760607`, where MilvanceCore was deployed, and
works forward. It does not start at "now" — that would silently lose the entire
trade history the demo is about.

Watch it climb:

```bash
curl -s https://<your-api>.onrender.com/api/indexer/status
```

Wait until `scannedThroughLedger` is close to chain head and
`unprojectedSuccessfulEvents` is `0`. At one bounded tick a minute this takes a
while; you can hurry it along from your own machine with the same endpoint the
cron calls:

```bash
for i in $(seq 1 40); do
  curl -sS -X POST https://<your-api>.onrender.com/api/internal/indexer/tick \
    -H "Authorization: Bearer <INDEXER_CRON_SECRET>" | head -c 200; echo
done
```

## 13. Check it against the contract

Orders, milestones, finance positions and settlements should now exist, because
they came from chain:

```bash
curl -s https://<your-api>.onrender.com/api/health/ready
curl -s https://<your-api>.onrender.com/api/reconcile/orders/1
curl -s https://<your-api>.onrender.com/api/metrics/public
```

Reconciliation reads the contract directly and compares it to the row. If it
disagrees, trust the contract and replay — never edit the database.

**What will legitimately be missing:** off-chain records that were never on
chain to begin with — evidence documents uploaded to the old deployment,
Anchor conversion records, Trade Lab consent rows. They cannot be rebuilt from
Stellar and they must not be invented. New ones are created by using the
product for real, through the browser.

## 14. Deploy the web app to Vercel

vercel.com → **Add New → Project** → this repository, branch
`deploy/free-hackathon`.

Set **Root Directory** to `apps/web`. Vercel detects Next.js from there.

Environment variables — all six are public by design; they are addresses and
URLs, not credentials:

| Variable                           | Value                                                         |
| ---------------------------------- | ------------------------------------------------------------- |
| `NEXT_PUBLIC_API_URL`              | `https://<your-api>.onrender.com`                             |
| `NEXT_PUBLIC_TRADE_LAB_ORIGIN`     | your Vercel URL (set after step 15 if you do not know it yet) |
| `NEXT_PUBLIC_ANCHOR_HOME_DOMAIN`   | `tr-mock-anchor.fly.dev`                                      |
| `NEXT_PUBLIC_ANCHOR_MOCK_MODE`     | `true`                                                        |
| `NEXT_PUBLIC_STELLAR_NETWORK`      | `testnet`                                                     |
| `NEXT_PUBLIC_MILVANCE_CONTRACT_ID` | `CCN6AZHLN2BQPCDZWXJGA3NRJEJ56V5JK3M4VZ5QFKQ3NSJBN6RVTKRX`    |

No server secret may ever be added here. If a variable belongs in Render, it
does not belong in Vercel.

## 15. Point the API at the web app

Render → `milvance-api` → Environment → set `WEB_URL` to your Vercel origin,
then redeploy.

This is the CORS allowlist, and it is an allowlist rather than a wildcard.
Until it matches, the browser will block every API call.

## 16. Set the invite origin

If you had not set `NEXT_PUBLIC_TRADE_LAB_ORIGIN` in step 14, set it now to the
Vercel URL and redeploy the web app.

Unset, invite links and QR codes carry whatever origin the browser is on. A
`localhost` QR code resolves to the phone that scans it, not to your laptop.

---

## Check it the way a judge will

```bash
WEB_URL=https://<your-web>.vercel.app \
API_URL=https://<your-api>.onrender.com \
pnpm e2e
```

Then, in a browser you have never used for this project — a private window is
enough:

1. Open the web URL. The landing page and `/demo` must work **with no wallet**.
2. `/app/metrics` — public traction numbers.
3. Connect Freighter on Testnet, open Trade Lab, look at a real order.
4. Take one real action and watch it appear. The workspace asks the API to
   index immediately rather than waiting for the next scheduled tick, so this
   should take seconds, not a minute.
5. Upload evidence, then redeploy the API and retrieve it again. Same bytes,
   same SHA-256: that is the difference between real object storage and a
   container's disk.
6. Check that an invite link or QR code points at the public origin and not at
   `localhost`.

## Before the judges arrive

Free tiers idle. Ten minutes before the demo:

- [ ] Supabase project is **Active**, not paused
- [ ] `select count(*) from "OrderReadModel";` answers
- [ ] `milvance-indexer-tick` is `active` in `cron.job`
- [ ] its last run in `cron.job_run_details` succeeded
- [ ] `/api/health/live` answers
- [ ] `/api/health/ready` is `ok` (not `degraded`)
- [ ] `/api/indexer/status` shows a current `scannedThroughLedger`
- [ ] the web app loads in a private window
- [ ] a Render free service sleeps when idle — **open the API URL once** and
      let it wake before you present

## What this deployment is not

It is a hackathon demo, not commercial infrastructure, and the write-up should
say so:

- **Render free services sleep after inactivity** and wake on the next request,
  which takes tens of seconds. The first judge to arrive pays that cost.
- **Supabase free projects pause after a week of inactivity** and have bounded
  database and storage sizes.
- **Vercel Hobby is for non-commercial use.** It is the right licence for a
  personal hackathon entry and the wrong one for the B2B product.
- **One Render free web service, in one workspace.** Free instance hours are a
  workspace-wide allowance. Do not run a second always-on free service here for
  this stack, and account for anything else already consuming them.
- **Indexing is once a minute**, so the read model can be up to a minute behind
  chain. `/api/health/ready` reports that as degraded rather than hiding it,
  and nothing financial depends on it: Soroban is the truth, and the database
  is a cache that can be rebuilt at any time.

None of that changes what the product is. It changes how quickly the first page
loads.

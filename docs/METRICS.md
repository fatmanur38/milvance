# Public metrics

Milvance publishes traction at `/app/metrics`, served by `GET /api/metrics/public`.

Every number on that page is derived from indexed MilvanceCore events, or is an
Anchor report explicitly labelled as one. Nothing can be typed in, there is no
counter to increment, and no request parameter changes a figure. The endpoint
serves each metric's definition next to its value, so a reader can disagree with
a definition without reading the source.

## The three populations, never mixed

| Section                   | What it counts                                     | Includes our wallets?   |
| ------------------------- | -------------------------------------------------- | ----------------------- |
| Testnet protocol activity | What MilvanceCore has actually done                | **Yes**, and it says so |
| Local payments            | TRY ↔ USDC conversions reported through the Anchor | Yes                     |
| External adoption         | Wallets whose owners said they are not on the team | **No**                  |

Demo activity is not hidden. It is real proof that the system works, so it is
published and labelled as team-generated testnet activity rather than quietly
folded into adoption.

## North-star metric

**Completed local-payment finance cycles.** A milestone counts once, and only
when all four of these are true:

1. a buyer fully protected it in contract escrow (`milestone_funded`),
2. a funder advanced their own USDC to the supplier (`advance_funded`),
3. the contract settled it, repaying the funder first (`milestone_settled`),
4. a local-money conversion belonging to a party of that trade has a Stellar
   leg that **Stellar itself confirms**.

The fourth condition is the one that keeps the metric honest. An Anchor report
is a client's word; it becomes evidence only when Horizon agrees that the
reported transaction is a payment of the approved USDC asset, in the reported
direction, for the reported amount, involving the reported wallet.

### What the link does and does not claim

The link is **wallet identity plus ordering in time**: a supplier's off-ramp
must come after the advance they are converting; a buyer's on-ramp must come
before the cycle closed. It is _not_ a claim that the same USDC units flowed
through, because USDC is fungible and that claim would be false.

Matching amounts alone prove nothing, and the page says so. Our own live data
demonstrates why: the mock Anchor pays every 1000 TRY conversion the same USDC
amount, so a report once named a transaction that paid a different wallet the
identical figure. That report is recorded as `MISMATCHED` and supports nothing.

### Two shapes of cycle

- **Supplier off-ramp** — the canonical narrative: the advance became local money
  the supplier can spend on production.
- **Buyer on-ramp** — local capital entered through the Anchor and was then
  protected into the milestone.

Both are reported separately, so an on-ramp cycle can never be read as a
supplier having been paid in local currency.

## Money

USDC is aggregated as `bigint` in base units (7 decimals; 1 USDC = 10,000,000)
and published as an integer string. Local currency is aggregated as exact
fixed-point base units and published with its recorded precision. No
authoritative figure is ever a JavaScript number, and formatting happens only in
the browser.

Escrow that has already been released still counts as protected. Settlement and
refund zero a milestone's escrow on chain, so summing the live column alone
would report zero and erase every completed trade. Protected volume is therefore
settled amounts + refunded amounts + escrow still held — three disjoint sets,
so nothing is counted twice.

Buyer escrow and funder advances are never added together. They are separate
money from separate people, and combining them would misrepresent the product.

## External participation

A wallet counts as external only when its owner used the Trade Lab consent
control to say both "count me" and "I am not on the team". Nothing is inferred
from behaviour. Consequences:

- An untagged wallet is **unclassified**, never external.
- Declaring yourself team-side is one-way, so nobody can re-tag into adoption.
- A consent row alone proves nothing: the wallet must also appear in chain state.
- If no genuine outside participant exists, the number is **zero**.

The three buckets — external, team, unclassified — always add up to the distinct
wallets seen on chain.

## Provenance labels

| Label                     | Meaning                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| On chain                  | Projected from MilvanceCore events; rebuildable from Stellar       |
| Anchor-reported           | A client or Anchor's word; no blockchain can prove a bank transfer |
| Reported, Stellar-checked | A report whose Stellar leg Horizon confirms                        |
| Self-declared             | A wallet owner's statement about themselves                        |

## Deliberately not published

| Metric                                 | Why                                                                                                                        |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `walletsConnected`                     | A wallet connection is a browser event. Counting clicks as usage is exactly what a traction dashboard must not do.         |
| `financedShipmentOrDeliveryMilestones` | MilvanceCore stores no stage name. "Shipment" comes from a Trade Lab template and lives only in the browser that chose it. |
| `medianDemoCompletionTime`             | Published as `medianOrderCompletionSeconds`, measured between chain timestamps rather than screens someone visited.        |

## Replay and idempotency

PostgreSQL is a derived read model. `pnpm --filter @milvance/api indexer replay`
drops the chain-derived rows and rebuilds them from Stellar, and the metrics
return to identical values — a test asserts exactly that. A duplicate event
changes nothing: the indexer filters by event id and projections are monotonic
in it.

Anchor reports and their Stellar verdicts are off-chain metadata that a replay
does not touch, so a verification survives a rebuild. Cycles are recomputed from
those stored verdicts with no network access, which is why serving metrics never
depends on Horizon being reachable.

## Verifying local-payment legs

```bash
pnpm --filter @milvance/api cycles verify    # check new reports, rebuild cycles
pnpm --filter @milvance/api cycles recheck   # re-check every report
pnpm --filter @milvance/api cycles derive    # rebuild cycles, no network
pnpm --filter @milvance/api cycles status    # print cycles without writing
```

Verification is a deliberate operation rather than something a page load
triggers: the verdict is written down with a reason, and an unchecked leg simply
supports no cycle. The failure mode is "counts nothing", never "counts wrongly".

## Live figures

Read from the running stack against the deployed contract. Re-read them rather
than trusting this table — it is a snapshot, and the API is the source:

```bash
curl -s localhost:3001/api/metrics/public | jq '.protocolActivity, .localPayments, .northStar, .adoption'
```

### Protocol activity — includes our own demo wallets

| Metric                         | Value |
| ------------------------------ | ----- |
| Orders created / completed     | 3 / 1 |
| Milestones created / protected | 3 / 2 |
| USDC protected                 | 20.00 |
| USDC advanced to suppliers     | 8.00  |
| USDC repaid to funders         | 9.00  |
| USDC settled to suppliers      | 1.00  |
| USDC refunded to buyers        | 10.00 |
| Disputes opened / refunds      | 1 / 1 |
| Distinct participating wallets | 5     |

### Local-payment legs

| Metric                               | Value    |
| ------------------------------------ | -------- |
| On-ramps reported (TRY → USDC)       | 2        |
| Off-ramps reported (USDC → TRY)      | 1        |
| Legs confirmed on Stellar            | 2        |
| Legs that failed their Stellar check | 1        |
| Legs not yet checked                 | 0        |
| TRY onboarded                        | 2,000.00 |
| TRY paid to suppliers                | 970.82   |

### The two headline numbers

| Metric                                     | Value |
| ------------------------------------------ | ----- |
| **Completed local-payment finance cycles** | **1** |
| **External participating wallets**         | **0** |

**The cycle closed.** One milestone now satisfies all four conditions: the buyer
protected it, an independent funder advanced their own USDC to the supplier, the
contract settled it funder-first, and the supplier converted that money to TRY
through the Anchor — with the Stellar leg confirmed by Horizon, not merely
reported. It is a supplier off-ramp cycle; no buyer on-ramp cycle has completed,
and the two are reported separately so one can never be read as the other.

**External participation is still zero, and that is the honest number.** Five
wallets have acted on the contract and none has declared itself outside the
team. Participation is opt-in and self-declared, so no amount of our own demo
activity can move this figure.

**One reported leg still fails its Stellar check**, and is published as failing.
It is the on-ramp described above: the report named a transaction that paid a
different wallet the identical amount. It is stored as `MISMATCHED` with the
reason and supports no metric. It is left in place deliberately — a metrics page
that quietly drops its own bad data is not a metrics page.

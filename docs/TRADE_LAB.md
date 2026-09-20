# Trade Lab

Trade Lab makes a real Milvance trade fast to set up and easy to follow. It is
not a demo mode, a sandbox or a second product: every trade it starts is a
Soroban transaction signed in someone's wallet, and every number it shows comes
back from the contract through the indexer.

## What it adds, and what it refuses to add

| It does                                            | It never does                           |
| -------------------------------------------------- | --------------------------------------- |
| Suggests stages and amounts for a realistic trade  | Signs, submits or pre-funds anything    |
| Generates invite links and QR codes for the roles  | Grants a role, or bypasses the contract |
| Shows where a trade has got to, derived from chain | Lets anyone tick a financial step       |
| Points at the next action for the connected wallet | Build a second transaction path         |
| Starts a fresh trade for a repeat run              | Rewind, reset or edit chain history     |

## Routes

| Route                      | Purpose                                                     |
| -------------------------- | ----------------------------------------------------------- |
| `/app/trade-lab`           | Pick a template, create the trade, see your runs            |
| `/app/trade-lab/[orderId]` | One run: progress, next action, invites, the milestone card |
| `/app/trade-lab/join`      | What an invite link or scanned QR opens                     |
| `/trade-lab/join`          | Short link from AGENT.md §PKG-10, forwards to the join page |

## Templates

A template is preparation material: stage names, suggested amounts, a financing
example and an explanation of what each stage means in a real trade. Two ship
with the product — a five-minute task for a conference queue, and a cross-border
manufacturing order with Production and QC, Shipment and Delivery, which is the
shape the product exists for.

Stage names live only in the interface. MilvanceCore stores an index, an amount,
an optional date and a status — no name — so the lab never presents a stage name
as something the contract enforces.

Every shipped template is checked against the contract's own rules in tests:
amounts must parse as USDC and be positive, a trade cannot exceed the 20
milestone limit, and the financing example must ask for less than the protected
amount while repaying at least the principal and at most the escrow. A template
that would walk a demo into a guaranteed rejection fails the build.

## Invites and QR codes

An invite is navigation with context:

```text
/app/trade-lab/join?order=42&role=supplier
```

The `role` is a hint. It selects the explanation on the page and nothing else.
It is never passed to a contract call and cannot make an action appear: what a
wallet may do is derived from the addresses MilvanceCore stores on the order,
and the contract checks again when a transaction is signed. Someone opening a
resolver link with the wrong wallet sees a resolver explanation, the address the
trade actually expects, and no resolver powers.

Order and milestone ids must be plain positive integers within u64; roles must
be one of five known words; an unknown template id is ignored; unknown
parameters are dropped rather than carried along or reflected. A malformed link
lands on an explanation instead of being followed.

QR codes encode that same absolute link and nothing else. Before a payload is
drawn it is checked: http(s) only, no credentials, no fragment, only the four
known query parameters, and no token, secret key or database string anywhere in
it. A link that fails refuses to become a QR code rather than appearing on a
screen in a room full of people.

### Which host a shared link points at

A link carries the origin the app is served from. In local development that is
`http://localhost:3000`, which is correct in the browser that made it and
useless on any other device: a phone resolving `localhost` reaches the phone.
Trade Lab says so next to the QR rather than letting it be discovered mid-demo.

When the app is reachable at an address attendees can use but the browser cannot
name — a tunnel, or a hostname on the venue network — set
`NEXT_PUBLIC_TRADE_LAB_ORIGIN` to that origin and every invite and QR follows it.
No address is hardcoded, a value that is not a plain http(s) origin is ignored in
favour of the browser's own, and the payload safety checks above still apply to
the result.

## Progress comes from the chain

The run page shows ten steps, from "Trade created" to "Settled — funder repaid
first". Each is answered by the read model, which is a projection of contract
events. There is no checkbox, no local tally and no override: open the same
trade on another laptop and it reads the same, because the progress is the
chain state.

The contract's ordering fills in what must have happened — a verified milestone
was evidenced, an advance implies an offer was made and chosen — while financing
stays optional: a milestone that reached verification without a request was
simply never financed, and those steps are shown as skipped rather than pending.
A refunded milestone never shows settlement as done, because that money went
back to the buyer.

## Roles and wallets

One person can play every role with several Freighter accounts. The workspace
follows an account switch on its own (PKG-09), so the lab only has to say whose
turn it is. It never impersonates a wallet, and a mismatch is explained rather
than worked around: the page names the address the contract expects and waits.

## Running it again

Soroban state is history. A settled milestone stays settled, a refunded one stays
refunded, and an accepted order can never return to draft — the contract has no
such transition, and rewriting the read model would be inventing financial
history. So a repeat demo is a NEW trade, producing new real chain state.

The only thing the lab stores locally is which template a trade followed, since
the chain does not keep stage names. Removing a run clears that note in that
browser and nothing else.

## Testnet only

Trade Lab states plainly that it runs on Stellar Testnet against the deployed
contract, with test USDC from the approved issuer. It has no simulated mode and
no shortcut to disable, and the existing network guard refuses to sign when the
wallet is on another network.

## Local payments and evidence

The supplier's route from an advance to local money is the PKG-07 Anchor flow,
reached from the milestone card with the amount prefilled. Trade Lab does not
reimplement any of it.

For evidence, the lab links a synthetic sample document that contains nothing
real and nothing personal. The browser hashes the file, the bytes stay off-chain
and only the SHA-256 fingerprint is committed by the supplier's wallet. The
attestor still reads the document and decides; Stellar cannot inspect goods.

## Counting participants

Trade Lab asks whether a wallet may be counted as someone outside the team who
used the product. It stores a wallet address, a consent flag and a team flag —
no name, no contact, nothing else — and consent can be withdrawn. Declaring
yourself part of the team is one-way: it only ever removes a wallet from external
counts, and no browser can clear it.

Consent is not evidence of use. Public traction numbers belong to PKG-11 and must
come from indexed contract events, not from this record.

## Live proof (PKG-10)

Run on Stellar Testnet against `CCN6AZHLN2BQPCDZWXJGA3NRJEJ56V5JK3M4VZ5QFKQ3NSJBN6RVTKRX`,
through the browser with Freighter, by a person signing every transaction.

**A trade started from a template.** The buyer opened Trade Lab, chose the fast
task template, and created trade #3 with the supplier, attestor and resolver
prefilled from their previous trade:

| What        | Value                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Transaction | [`dfe502b1…4bb4`](https://stellar.expert/explorer/testnet/tx/dfe502b199d7af3f528ca1fdd3e4c07817b4f8e206f4e3a8e2a93c006feb4bb4) |
| Call        | `create_order`, one signature, source = buyer                                                                                  |
| Event       | `order_created` #3, indexed exactly once                                                                                       |
| Money moved | none — the footprint touches only MilvanceCore storage                                                                         |

The template chose the wording and the suggested amounts. It signed nothing and
wrote nothing: the transaction was built by the generated bindings, simulated,
and signed in Freighter like any other order.

**An invite grants nothing.** The buyer generated the supplier invite and opened
it while still connected as the buyer. The page named the supplier address the
contract holds for trade #3, named the connected buyer wallet, said _"This is not
the wallet this role expects"_, and offered no supplier action — `?role=supplier`
changed only the explanation.

**The right wallet is recognised without reconnecting.** Switching Freighter to
the supplier changed the same page to _"This wallet matches"_ on its own, through
the PKG-09 account poll. No disconnect, no reload, and no impersonation: the app
waited for the human to switch accounts.

**Nothing was written outside the chain.** After the proof, orders #1 and #2 were
byte-identical to their recorded state, every order and milestone reconciled
against the contract, and the participant table was empty.

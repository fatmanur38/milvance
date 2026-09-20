# Milvance — Threat model

Milvance moves real value between five parties who do not fully trust each
other. This document states what the contract actually enforces, what it
deliberately does not, and who you are trusting when you use it. Where a
protection is social rather than cryptographic, it says so.

**The headline limit: Milvance does not verify the physical world.** Whether
goods were manufactured, inspected, shipped, delivered or accepted is
established by a human attestor the buyer and supplier both named. Stellar
records that person's decision. It cannot check a factory.

## Trust boundaries

| You are trusting    | With what                                                        | If they are wrong or dishonest                                                                                                               |
| ------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **The attestor**    | Deciding whether the work matches what was promised              | Escrow is released for work that was not done, or withheld from work that was. The contract enforces only that _this named address_ decided. |
| **The resolver**    | Deciding a dispute: release to the supplier, or refund the buyer | The wrong party keeps the money. The contract enforces only that the resolver named on the order decided.                                    |
| **The Anchor**      | Holding and paying local currency; KYC                           | The fiat leg fails or is delayed. No blockchain can prove a bank transfer happened.                                                          |
| **Freighter**       | Holding your keys and showing you what you sign                  | Standard wallet risk. Milvance never sees a key.                                                                                             |
| **Stellar Testnet** | Liveness and history                                             | This is a testnet. Data can be reset by the network operators; that is a property of the demo, not of the design.                            |

Choosing the attestor and resolver is the real security decision a buyer and
supplier make. The contract makes that choice explicit and immutable for the
life of the order, which is the most it can honestly do.

## What the contract enforces

These are checked on chain and covered by the contract's 180 tests.

| Invariant                                 | Meaning                                                        |
| ----------------------------------------- | -------------------------------------------------------------- |
| Only the buyer funds escrow               | No one else can put money into a milestone                     |
| Only the named attestor verifies          | A stranger's verification is rejected                          |
| Only the named resolver resolves          | A dispute cannot be decided by a party to it                   |
| One active finance position per milestone | A milestone cannot be financed twice                           |
| The funder must be independent            | Not the buyer, supplier, attestor or resolver                  |
| Requested principal ≤ protected amount    | A supplier cannot borrow more than is protected                |
| Repayment ≥ principal, and ≤ escrow       | A funder cannot be owed more than escrow can pay               |
| Funder repaid first, exactly              | Settlement pays the funder, then the remainder to the supplier |
| Settlement only from VERIFIED             | Escrow cannot be released before verification                  |
| Terminal states are terminal              | A settled or refunded milestone cannot be settled again        |
| Milestones are isolated                   | A dispute on one milestone does not freeze its siblings        |
| A deadline alone moves nothing            | Expiry is informational; only a signed action moves money      |

## Risks the design accepts

**A refund does not reverse a funder's advance.** If a milestone is refunded,
the buyer's escrow returns to the buyer and the supplier keeps the working
capital the funder already paid them. The contract records the outstanding
amount in the refund event and closes the position; recovering it is an
off-chain matter between funder and supplier. This is deliberate — clawing back
money a supplier has already spent on materials would defeat the purpose — but
it means **the funder takes supplier performance risk.** Buyer escrow is not a
guarantee to the funder.

**An on-chain position is not a legal assignment of a receivable.** It is an
enforceable record of who is owed what, out of a specific escrow, in a specific
order. Turning that into a legally enforceable claim needs a contract between
the parties in their own jurisdictions. Milvance does not provide one.

**Non-custodial does not mean unregulated.** Milvance holds no keys and signs
nothing for users. That removes custody risk; it does not remove money
transmission, KYC or lending obligations that may apply to the participants or
to a production Anchor.

**Evidence proves integrity, not truth.** The chain stores a SHA-256 of a
document. That proves the document shown to the attestor is byte-identical to
the one committed, and that it has not been altered since. It says nothing
about whether the document is honest.

## Attack scenarios and what stops them

| Attack                                                      | What stops it                                                                                                                                                                                |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Someone opens an invite link for a role they do not hold    | The role in a URL is wording only. Permissions come from the addresses on the order, re-checked by the contract at signature.                                                                |
| A funder tries to fund the same milestone twice             | One active position per milestone, enforced on chain                                                                                                                                         |
| A supplier submits new evidence after verification          | Evidence replacement is refused once the milestone is verified                                                                                                                               |
| A resolver tries to reopen a resolved dispute               | Terminal dispute states reject further resolution                                                                                                                                            |
| A settlement is attempted twice                             | Terminal milestone states reject a second settlement                                                                                                                                         |
| Someone edits PostgreSQL to fake a payment                  | PostgreSQL is a projection. `indexer replay` rebuilds it from Stellar and the edit disappears. The reconcile endpoints compare each row to the contract on demand.                           |
| A backend is compromised                                    | It has no signing key and no user funds. It can serve wrong _reads_, which reconciliation detects, but it cannot move money.                                                                 |
| A malicious path in an evidence key                         | Storage keys are derived from the digest, never from user input, and re-checked for traversal before any I/O                                                                                 |
| A SEP-10 token reaches our servers                          | The browser holds its own Anchor session. The local-payment endpoint rejects any field named like a credential rather than silently dropping it.                                             |
| A local-payment report claims a transaction it does not own | Every reported Stellar leg is checked against Horizon for asset, direction, wallet and amount. A mismatch is recorded and published, and supports no metric.                                 |
| A stranger calls the scheduled-indexer endpoint             | It needs a bearer secret, compared in constant time. With no secret configured the endpoint is disabled rather than open, and a rejection is logged without the credential.                  |
| A caller tries to index events of its own choosing          | The tick endpoint has no request body. It cannot be given a ledger, a cursor or an event; everything it stores is read from the configured Stellar RPC by the same code the CLI worker runs. |
| A scheduler fires on top of a running tick                  | A tick takes a lease on the stream first and a second arrival is told `already_running`. A lease left by a killed process expires on its own rather than wedging the stream.                 |
| The public catch-up nudge is called in a loop               | It is bounded and on a cooldown, takes no parameters, and can only cause the work the scheduler was going to do anyway. It cannot rewind a cursor or replay a read model.                    |

## Known demo-scope limits

- **Testnet only.** Test USDC from a known issuer; no real money at any point.
- **Mock Anchor.** `tr-mock-anchor.fly.dev` simulates KYC and the bank leg. It
  is a sandbox, clearly labelled in the UI, and its "simulate bank transfer"
  control exists only because no real bank is involved.
- **Attestor and resolver are set once, at order creation.** There is no
  rotation, no multi-attestor quorum and no appeal beyond the named resolver.
- **No partial settlement.** A milestone settles in full or refunds in full.
- **Scheduled indexing on the free deployment.** Where there is no always-on
  worker, an external scheduler calls a bounded tick each minute, so the read
  model can be up to a minute behind chain. This is reported as degraded by
  `/api/health/ready` rather than hidden, and it changes nothing financial:
  Soroban remains the source of truth and the database is rebuildable.
- **Indexer RPC retention.** Public Testnet RPC keeps a limited window of
  history. A database rebuilt after the deployment ledger falls outside that
  window cannot backfill from RPC alone; see
  [API read layer](API_READ_LAYER.md) for how this is detected and reported
  rather than silently skipped.

## What a compromise of each component costs

| Compromised      | Worst case                                                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Web app          | Phishing: a user could be shown a transaction to sign. Freighter still displays the real contents, and the contract still checks the signer. |
| API + database   | Wrong reads, which reconciliation detects. No ability to move funds.                                                                         |
| Object storage   | Evidence documents disclosed. The bucket is private and reachable only through the API; no document is ever public by default.               |
| Indexer          | Stale or wrong projections. Replay repairs them from chain.                                                                                  |
| A party's wallet | That party's own actions, exactly as if they had taken them.                                                                                 |

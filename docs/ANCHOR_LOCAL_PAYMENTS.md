# PKG-07 local payments (Anchor)

Milvance settles in Stellar USDC, but a Turkish supplier pays for materials, labour,
energy and local logistics in TRY. This package is the edge where those two meet:

```text
TRY → Anchor → USDC → protected milestone / funder advance
funder advance → USDC → Anchor → TRY → production starts
```

The second direction is the one that matters commercially. A supplier who has just
received a funder advance can convert it immediately and buy materials — which is
the whole point of the advance existing.

## Architecture boundary

- `packages/anchor` — the replaceable adapter. `AnchorProvider` is the only surface
  the rest of Milvance uses; `SepAnchorProvider` implements it over SEP-1, SEP-10,
  SEP-12, SEP-38 and SEP-6 (not SEP-24).
- `MockAnchorDevDriver` — hackathon-only. The sandbox exposes one route no real
  Anchor has, `POST /sep6/tx/{id}/simulate-bank-transfer`, because a production
  Anchor learns that TRY arrived from its bank integration and this one needs to be
  told. Nothing in `SepAnchorProvider` imports it; delete the file and the standard
  SEP path still compiles and runs. It also refuses to act unless the build opts in
  via `NEXT_PUBLIC_ANCHOR_MOCK_MODE`.
- `apps/web/lib/anchor` — browser wiring. `apps/web/app/anchor` is a minimal proof
  surface, not the PKG-09 product UI.

Only the home domain is configured. Every endpoint is discovered from the Anchor's
`stellar.toml` at runtime, so moving to a production Turkish Anchor is a one-string
change.

## Non-custodial boundary

The Anchor serves permissive CORS, so the browser talks to it directly and **no
Milvance server is in the path**. Consequences, all deliberate:

- The user's wallet signs the SEP-10 challenge. No Milvance code holds a key.
- The user's wallet signs the USDC payment that settles a withdrawal.
- The SEP-10 JWT lives only in a module closure for the life of the tab. It is not
  in `localStorage`, not in `sessionStorage`, not in React state that could be
  serialized, and never reaches a backend. Closing the tab ends the session.
- Anchor error bodies are never echoed into error messages, because an Anchor error
  can repeat the request and the request carried the bearer token.

## What is real and what is simulated

| Part                                      | Status                                                     |
| ----------------------------------------- | ---------------------------------------------------------- |
| SEP-10 auth, SEP-6/12/38 protocol surface | Real                                                       |
| FX rate and spread                        | Real (oracle-derived, 50 bps)                              |
| Stellar USDC movement                     | Real Testnet                                               |
| Incoming TRY bank transfer                | **Simulated** by the sandbox                               |
| TRY payout to an IBAN                     | **Simulated**, instant FAST-style reference                |
| KYC                                       | **Simulated**: `NEEDS_INFO` until any PUT, then `ACCEPTED` |

The UI states this plainly and fences the simulator behind a dashed "Sandbox tool —
not a real bank transfer" panel. Simulated hackathon KYC is not production KYC.

## Verified live Testnet proof

Both directions were proven twice on Stellar Testnet against
`tr-mock-anchor.fly.dev`: first over the raw SEP protocol with a throwaway
account, then through the real browser UI with a Freighter-signed session.

## Proof 1 — protocol run (throwaway account)

### TRY → USDC (on-ramp)

- Quote `qt_aolm8huhhd455ytubqns`: **1,000.00 TRY → 20.3960908 USDC**, total price
  49.0290031, fee 4.98 TRY (50 bps spread).
- Anchor transfer `sep_n4kl7lygqpyd03fy2mjx`, status walked
  `pending_user_transfer_start → pending_anchor → completed`.
- Stellar settlement:
  [`972f19ea5a0c45ac9bcd26d033f183643ba06d5def94b45d7322b0c1dec5db4a`](https://stellar.expert/explorer/testnet/tx/972f19ea5a0c45ac9bcd26d033f183643ba06d5def94b45d7322b0c1dec5db4a)
- On-chain USDC balance after: **20.3960908**.

### USDC → TRY (off-ramp, the supplier cash-out)

- Quote `qt_oyjz8zpszqnkxl6rpllt`: **20 USDC → 970.82 TRY**.
- Anchor transfer `sep_f57e3of9hidz0muccmse`, memo **`702799274298`** (type `id`),
  anchor account `GCLCZEQZ2THTEDAOFI66LACNPLY4OBKN7VKLEZFMBIHYKYQOW2W7T3Z6`.
- Wallet-signed USDC payment carrying that memo:
  [`5e0ee636f4c134b67c5d0accfbe87ba0a3187b2c6363f60bee2c5b5a43d73dc2`](https://stellar.expert/explorer/testnet/tx/5e0ee636f4c134b67c5d0accfbe87ba0a3187b2c6363f60bee2c5b5a43d73dc2)
- Status reached `completed` with payout reference `FAST-I6BN52CMY3`.
- On-chain USDC balance: **20.3960908 → 0.3960908**.

## Proof 2 — browser run signed with Freighter

The same two flows were then driven entirely from `http://localhost:3000/anchor`
by a human using the Freighter extension. Every Stellar signature came from the
browser wallet; no key was ever held by Milvance. Both hashes below were verified
independently against Horizon rather than taken from the UI.

### TRY → USDC (on-ramp)

- Quoted at the Anchor's rate: **1,000.00 TRY → ≈20.3960908 USDC**.
- Stellar settlement:
  [`cc50640ab6bd9e377e5fedad276186c748d7d92a7b75c15e1aafd5182e1415fa`](https://stellar.expert/explorer/testnet/tx/cc50640ab6bd9e377e5fedad276186c748d7d92a7b75c15e1aafd5182e1415fa)
- Ledger **4,763,352**, `2026-09-19T17:52:27Z`, status **SUCCESS**.
- One `payment` operation of **20.3960908 USDC** from the Anchor's declared
  distribution account `GCLCZEQZ…W2W7T3Z6` to the browser wallet, in USDC issued
  by the approved Testnet issuer in `deployments/testnet.json`.

### USDC → TRY (off-ramp)

- Quoted at the Anchor's rate: **20 USDC → 970.82 TRY**; the UI reported the TRY
  payout as `completed`.
- Wallet-signed payment:
  [`a9f38d19afa9c153290799e6e82058b6def395d16688a830c85b93f3563f29c7`](https://stellar.expert/explorer/testnet/tx/a9f38d19afa9c153290799e6e82058b6def395d16688a830c85b93f3563f29c7)
- Ledger **4,763,239**, `2026-09-19T17:43:02Z`, status **SUCCESS**.
- One `payment` operation of **20.0000000 USDC** from the browser wallet to the
  same declared Anchor account, carrying the required withdrawal memo
  **`653161731091`** (type `id`).

### What this proof does and does not show

- The signing account is the same browser wallet that produced the PKG-06 live
  proof, and it is **not** the deployer identity in `deployments/testnet.json`.
- Both legs move USDC from the approved issuer only, to or from an account the
  Anchor itself declares in `ACCOUNTS` in its `stellar.toml`.
- The account's Horizon balance history is arithmetically consistent with these
  two payments.
- The Anchor-side transfer IDs and the TRY payout reference are **not recorded
  here**: SEP-6 scopes every transfer to its authenticated account, so they
  cannot be retrieved without that user's bearer token, and the token is never
  stored, logged or committed. The TRY leg is therefore attested by the Anchor
  and by the operator's own screen, not by a public ledger — which is the
  expected shape for local money.

No secret key, JWT or KYC material appears in this repository or in either proof.

## Memo handling

A SEP-6 withdrawal is matched to its payment by memo. `planWithdrawalPayment`
refuses to build a payment when the Anchor returned no memo or no destination, so
the user cannot sign a transaction that would strand their USDC. The live run used
memo type `id`; `text` and `hash` are handled too.

## Running it

1. `cp .env.example .env` and keep `NEXT_PUBLIC_ANCHOR_MOCK_MODE=true` for the
   sandbox.
2. `pnpm --filter @milvance/web dev`, then open `http://localhost:3000/wallet` and
   connect Freighter on Stellar Testnet.
3. Open `http://localhost:3000/anchor`.
4. **Sign in to the local-payment provider** — Freighter will ask you to sign the
   Anchor's challenge. This proves your account to the Anchor; it moves no money.
5. **Complete verification** (simulated KYC).
6. `TRY → USDC`: enter 50–3000 TRY, get a rate, start the deposit, then use the
   sandbox panel to simulate the bank transfer. USDC arrives in your wallet.
   A USDC trustline is required to receive it.
7. `USDC → TRY`: enter at least 1 USDC, get a rate, and confirm. Freighter asks you
   to sign the USDC payment, memo included. The payout reference appears when the
   Anchor completes.

Rates expire. The UI counts the quote down and blocks using an expired one.

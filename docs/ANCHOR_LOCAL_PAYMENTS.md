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

Both directions were run end to end against `tr-mock-anchor.fly.dev` on Stellar
Testnet with a throwaway account.

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

No secret key, JWT or KYC material appears in this repository or in the proof above.

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

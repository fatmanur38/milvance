# PKG-06 wallet layer

The `/wallet` route is a minimal Testnet transaction proof, not the full product UI.
It uses Stellar Wallets Kit with its Freighter module. Only public address selection
is stored in browser local storage. Freighter keeps signing authority, and the web
app sends signed XDR directly to Stellar RPC through the generated MilvanceCore
client. The backend is not in this path.

## Verified live Testnet proof

- Transaction: [`5fafed67546e55aa79f441a5fdd5932bd4038bd05e3cc3af4c820e522c5783ee`](https://stellar.expert/explorer/testnet/tx/5fafed67546e55aa79f441a5fdd5932bd4038bd05e3cc3af4c820e522c5783ee)
- Network: Stellar Testnet; ledger: **4,761,475**; transaction status: **SUCCESS**.
- The signed transaction invoked `create_order` on the MilvanceCore ID in
  `deployments/testnet.json`. Its source account matched the buyer argument.
- The successful contract event was `order_created` for **order #1**.
- A fresh generated-binding read returned `order_count = 1` and order #1 in
  `Created` state. Its buyer and supplier matched the invocation, and its asset
  matched the approved USDC SAC in the deployment artifact.
- Horizon independently showed the buyer account's trustline for the approved
  Testnet USDC issuer.

This proves the PKG-06 browser-wallet authorization exit gate. Creating this empty
order did not fund a milestone or transfer USDC. Later financial actions still
require their own wallet authorization and validation.

The facts above describe the contract at ledger 4,761,475. Order #1 has changed
since: the PKG-09 browser proof added an unfunded 2,000 USDC milestone to it at
ledger 4,765,836, and later orders have raised `order_count`.

## Live check

1. Run `pnpm --filter @milvance/web dev` and open `http://localhost:3000/wallet` in
   the browser with Freighter installed.
2. Select **Stellar Testnet** in Freighter and connect. Fund the account on Testnet
   so it can pay transaction fees. The page checks the network passphrase against
   `deployments/testnet.json`; any other network blocks transactions.
3. The page checks Horizon for the approved Testnet USDC trustline and identifies
   missing or unfunded accounts. An empty order does not transfer USDC, so a
   trustline is not required for this one action. Add the approved USDC trustline
   in Freighter before future USDC transfers.
4. Enter three **distinct classic public G-addresses** for supplier, attestor and
   resolver. They must also differ from the connected buyer. Use addresses owned
   by the intended participants if the order will continue beyond this proof.
5. Click **Simulate and sign order** and review the Freighter request. On approval,
   the browser submits the transaction to Testnet, waits for confirmation, and
   reads the order from MilvanceCore again. Open the transaction explorer link to
   verify it independently.

Do not enter or share any secret seed in the app or in a bug report. A wallet
rejection, simulation error, or failed RPC submission leaves no confirmed order in
the UI. The contract itself enforces buyer `require_auth()`.

## Implementation boundary

- `apps/web/lib/wallet/freighter.ts`: browser-only Wallets Kit adapter.
- `apps/web/lib/wallet/provider.tsx`: application-wide wallet state provider.
- `apps/web/lib/wallet/controller.ts`: connection and transaction state machine.
- `apps/web/lib/wallet/contract.ts`: generated MilvanceCore client adapter.
- `apps/web/lib/wallet/trustline.ts`: Horizon read-only USDC trustline check.
- `deployments/testnet.json`: source for public contract, issuer and network values.

The Phase 1 contract and its financial invariants are unchanged. Anchor and local
payments are outside PKG-06.

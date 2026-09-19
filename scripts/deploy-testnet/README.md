# MilvanceCore Stellar Testnet deployment

PKG-05 deploys the existing Phase-1 contract with its constructor:

```text
__constructor(admin: Address, usdc: Address)
```

The admin is the deployer's **public address**. It has no withdrawal authority. The
USDC argument is the Stellar Asset Contract for the approved Testnet asset
`USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`.

## Requirements

- Stellar CLI 28.0.0, Rust toolchain and `wasm32v1-none` target from this repo.
- Node.js and pnpm from the root `package.json`.
- A locally configured, funded **Testnet-only** Stellar CLI identity. The default
  alias is `milvance-deployer`; set `MILVANCE_DEPLOYER_ALIAS` to use another local
  alias. Do not put a seed in the variable or in any repository file.
- Access to Stellar Testnet RPC and Horizon.

Check the public address and account before deploying:

```sh
stellar keys address milvance-deployer
stellar network info --network testnet
```

## Deploy and verify

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm deploy:testnet
pnpm bindings:generate
pnpm smoke:testnet
pnpm --filter @milvance/contract-bindings build
```

The deploy script builds the contract, verifies the Testnet passphrase and live
deployer account, derives the USDC SAC through both Stellar CLI and Stellar SDK,
and reads the SAC's live symbol and name. It then deploys with a deterministic
salt derived from the build's WASM hash and deployer public address. The script
checks the live WASM hash and constructor config before writing
`deployments/testnet.json`. Re-running it verifies and reuses the same contract;
it refuses to overwrite an artifact for a different WASM or deployer.

`bindings:generate` fetches the **live** contract spec and writes the Stellar
CLI-generated TypeScript source into `packages/contract-bindings/src/generated/`,
stripping only trailing whitespace from generated comments. Do not edit that
generated file. The smoke script makes read-only Testnet calls
to `protocol_version`, `get_config`, and `order_count`. It never sends a financial
transaction or changes demo state.

The artifact contains public addresses, network metadata, the WASM hash, and
deployment transaction hash/ledger when Horizon returns them. It contains no
secret. The contract and SAC IDs can be checked on Stellar Expert Testnet:

```text
https://stellar.expert/explorer/testnet/contract/<contract-id>
```

Testnet only. These scripts do not deploy to mainnet and do not sign any user
financial transaction.

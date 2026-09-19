# scripts/

Operational scripts. Each directory is a placeholder until its owning package.

| Directory         | Purpose                                                          | Implemented in |
| ----------------- | ---------------------------------------------------------------- | -------------- |
| `deploy-testnet/` | Reproducible Stellar Testnet deployment + contract init          | PKG-05         |
| `seed-demo/`      | Seed demo orders and Trade Lab participants                      | PKG-10         |
| `verify-demo/`    | Pre-demo readiness check (contract, trustlines, Anchor, wallets) | PKG-12         |

Rules that apply to every script here:

- never hardcode or commit a secret key,
- never sign a _user's_ financial transaction,
- read configuration from the environment (`.env.example` documents the contract),
- write deployment artifacts to `deployments/` so the live contract ID is reproducible.

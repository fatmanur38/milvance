# Milvance — Threat Model

> **Status:** placeholder (PKG-00). Completed in **PKG-12**.

Milvance does **not** claim trustless physical-world verification. Whether goods were
manufactured, loaded, shipped, delivered or accepted is established by an authorized
attestor, not by the contract.

## Threats to document

- [ ] Duplicate financing (two active positions on one milestone)
- [ ] Racing funders
- [ ] Unauthorized verification (wrong attestor)
- [ ] Unauthorized dispute resolution (wrong resolver)
- [ ] Double settlement / settlement after refund
- [ ] Repayment exceeding locked escrow
- [ ] Cross-milestone fund leakage
- [ ] Evidence tampering / overwrite after verification
- [ ] Malicious admin attempting withdrawal
- [ ] Anchor session (SEP-10 JWT) leakage
- [ ] Mock Anchor behaviour leaking into production paths
- [ ] Funder performance risk (advance is not guaranteed by buyer escrow)
- [ ] Deadline misuse (expiry must never move funds by itself)

## Trust assumptions to state explicitly

- [ ] Attestor honesty and assignment
- [ ] Resolver honesty and assignment
- [ ] Anchor solvency and KYC handling
- [ ] Testnet-only scope, simulated KYC and simulated bank transfer

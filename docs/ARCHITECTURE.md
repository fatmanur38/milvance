# Milvance — Architecture

> **Status:** placeholder (PKG-00). Completed in **PKG-12**.

## System shape

```text
User Wallets
   ↓
Stellar Wallets Kit          (user-controlled authorization — PKG-06)
   ↓
Soroban MilvanceCore         (financial source of truth — PKG-01…PKG-04)
   ↕
Stellar USDC

Anchor / SEP                 (local-money edge, TRY ↔ USDC — PKG-07)

Soroban Events
   ↓
Indexer                      (PKG-08)
   ↓
PostgreSQL Read Models       (cache/metadata/analytics — never financial truth)
   ↓
Web UI / Metrics             (PKG-09…PKG-11)
```

## Responsibility split

| Layer               | Responsibility                                                             |
| ------------------- | -------------------------------------------------------------------------- |
| Anchor / SEP        | Local-money interoperability (TRY ↔ USDC)                                  |
| Stellar USDC        | Common cross-border settlement asset                                       |
| Soroban             | Financial state machine, authorization, escrow, financing, repayment order |
| Stellar Wallets Kit | User-controlled transaction authorization                                  |
| PostgreSQL          | Read models, metadata, analytics — **not** a balance ledger                |

## Sections to complete

- [ ] Contract module layout and storage strategy (instance / persistent / temporary, TTL)
- [ ] State machines: order, financed milestone, unfinanced milestone, dispute
- [ ] Event catalogue and indexer contract
- [ ] Anchor adapter boundary and SEP sequence diagrams
- [ ] Wallet authorization flow
- [ ] Read-model rebuild procedure

# ADR 0001 — Record architecture decisions

- **Status:** Accepted
- **Date:** 2026-09-19

## Context

Milvance is built package-by-package under an explicit development constitution.
Decisions that change the financial mechanism, custody model, Anchor boundary or
settlement asset must be traceable rather than implicit in a diff.

## Decision

Architecture decisions are recorded as numbered ADRs in `docs/adr/`.

An ADR is required when a change touches any of:

- the economic separation between buyer escrow and funder advance,
- contract state machines or invariants,
- custody / authorization (who signs what),
- the financial source of truth,
- the Anchor adapter boundary,
- the settlement asset.

## Consequences

Reviewers and judges can trace _why_ the financial design looks the way it does,
and a later package cannot silently weaken an invariant to make a demo pass.

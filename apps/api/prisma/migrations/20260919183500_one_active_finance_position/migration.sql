-- Contract invariant 1, enforced in the read model too.
--
-- At most one ACTIVE FinancePosition may exist per milestone on chain. A
-- projection bug must not be able to invent a second live financing, so the
-- database refuses it outright rather than relying on application code.
--
-- Prisma's schema language cannot express a partial unique index, so it is
-- declared here and deliberately left out of `schema.prisma`.
CREATE UNIQUE INDEX "finance_position_one_active_per_milestone"
  ON "FinancePositionReadModel" ("network", "contractId", "milestoneId")
  WHERE "status" = 'ACTIVE';

-- Evidence digests are SHA-256, rendered as exactly 64 lower-case hex chars.
-- The contract stores BytesN<32>; anything else in this column is a bug.
ALTER TABLE "EvidenceObject"
  ADD CONSTRAINT "evidence_content_hash_is_sha256"
  CHECK ("contentHash" ~ '^[0-9a-f]{64}$');

-- Buyer escrow can never exceed the protected milestone amount, and neither
-- side of that comparison may go negative.
ALTER TABLE "MilestoneReadModel"
  ADD CONSTRAINT "milestone_funded_within_amount"
  CHECK ("fundedAmount" >= 0 AND "amount" >= 0 AND "fundedAmount" <= "amount");

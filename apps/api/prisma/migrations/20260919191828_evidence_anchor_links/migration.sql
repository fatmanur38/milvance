-- CreateTable
CREATE TABLE "EvidenceAnchorReadModel" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "milestoneId" BIGINT NOT NULL,
    "milestoneRowId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "submittedLedger" BIGINT NOT NULL,
    "submittedTxHash" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL,
    "lastEventId" TEXT NOT NULL,

    CONSTRAINT "EvidenceAnchorReadModel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EvidenceAnchorReadModel_network_contractId_contentHash_idx" ON "EvidenceAnchorReadModel"("network", "contractId", "contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceAnchorReadModel_network_contractId_milestoneId_key" ON "EvidenceAnchorReadModel"("network", "contractId", "milestoneId");

-- AddForeignKey
ALTER TABLE "EvidenceAnchorReadModel" ADD CONSTRAINT "EvidenceAnchorReadModel_milestoneRowId_fkey" FOREIGN KEY ("milestoneRowId") REFERENCES "MilestoneReadModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

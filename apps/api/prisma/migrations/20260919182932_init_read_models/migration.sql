-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('CREATED', 'ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MilestoneStatus" AS ENUM ('UNFUNDED', 'FUNDED', 'FINANCE_REQUESTED', 'FINANCED', 'SUBMITTED', 'VERIFIED', 'DISPUTED', 'SETTLED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "FinanceRequestStatus" AS ENUM ('OPEN', 'ACCEPTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OfferStatus" AS ENUM ('OPEN', 'CANCELLED', 'ACCEPTED', 'FUNDED');

-- CreateEnum
CREATE TYPE "FinancePositionStatus" AS ENUM ('ACTIVE', 'REPAID', 'CLOSED');

-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('OPEN', 'RESOLVED_SETTLE', 'RESOLVED_REFUND');

-- CreateEnum
CREATE TYPE "AnchorDirection" AS ENUM ('TRY_TO_USDC', 'USDC_TO_TRY');

-- CreateTable
CREATE TABLE "IndexedContractEvent" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "ledger" BIGINT NOT NULL,
    "txHash" TEXT NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "txIndex" INTEGER NOT NULL,
    "operationIndex" INTEGER NOT NULL,
    "eventName" TEXT NOT NULL,
    "successful" BOOLEAN NOT NULL,
    "ledgerClosedAt" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "topicsXdr" TEXT[],
    "valueXdr" TEXT NOT NULL,
    "projected" BOOLEAN NOT NULL DEFAULT false,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IndexedContractEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IndexerCursor" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "startLedger" BIGINT NOT NULL,
    "lastEventId" TEXT,
    "lastLedger" BIGINT,
    "scannedThroughLedger" BIGINT,
    "eventsIngested" BIGINT NOT NULL DEFAULT 0,
    "lastPollAt" TIMESTAMP(3),
    "lastEventAt" TIMESTAMP(3),
    "lastErrorAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lockedBy" TEXT,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IndexerCursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderReadModel" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "orderId" BIGINT NOT NULL,
    "buyer" TEXT NOT NULL,
    "supplier" TEXT NOT NULL,
    "attestor" TEXT NOT NULL,
    "resolver" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'CREATED',
    "createdLedger" BIGINT NOT NULL,
    "createdTxHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "lastEventId" TEXT NOT NULL,
    "lastLedger" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderReadModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MilestoneReadModel" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "milestoneId" BIGINT NOT NULL,
    "orderId" BIGINT NOT NULL,
    "orderRowId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "amount" DECIMAL(39,0) NOT NULL,
    "fundedAmount" DECIMAL(39,0) NOT NULL DEFAULT 0,
    "deadline" TIMESTAMP(3),
    "evidenceHash" TEXT,
    "status" "MilestoneStatus" NOT NULL DEFAULT 'UNFUNDED',
    "createdLedger" BIGINT NOT NULL,
    "createdTxHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "lastEventId" TEXT NOT NULL,
    "lastLedger" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MilestoneReadModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceRequestReadModel" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "milestoneId" BIGINT NOT NULL,
    "milestoneRowId" TEXT NOT NULL,
    "supplier" TEXT NOT NULL,
    "requestedPrincipal" DECIMAL(39,0) NOT NULL,
    "protectedAmount" DECIMAL(39,0) NOT NULL,
    "status" "FinanceRequestStatus" NOT NULL DEFAULT 'OPEN',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "cancelledWhileExpired" BOOLEAN,
    "createdLedger" BIGINT NOT NULL,
    "createdTxHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "lastEventId" TEXT NOT NULL,
    "lastLedger" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceRequestReadModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FundingOfferReadModel" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "offerId" BIGINT NOT NULL,
    "milestoneId" BIGINT NOT NULL,
    "milestoneRowId" TEXT NOT NULL,
    "funder" TEXT NOT NULL,
    "principal" DECIMAL(39,0) NOT NULL,
    "repayment" DECIMAL(39,0) NOT NULL,
    "status" "OfferStatus" NOT NULL DEFAULT 'OPEN',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdLedger" BIGINT NOT NULL,
    "createdTxHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "lastEventId" TEXT NOT NULL,
    "lastLedger" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FundingOfferReadModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinancePositionReadModel" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "milestoneId" BIGINT NOT NULL,
    "offerId" BIGINT NOT NULL,
    "milestoneRowId" TEXT NOT NULL,
    "funder" TEXT NOT NULL,
    "supplier" TEXT NOT NULL,
    "principal" DECIMAL(39,0) NOT NULL,
    "repayment" DECIMAL(39,0) NOT NULL,
    "protectedAmountAtFunding" DECIMAL(39,0) NOT NULL,
    "status" "FinancePositionStatus" NOT NULL DEFAULT 'ACTIVE',
    "fundedLedger" BIGINT NOT NULL,
    "fundedTxHash" TEXT NOT NULL,
    "fundedAt" TIMESTAMP(3) NOT NULL,
    "repaidAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "lastEventId" TEXT NOT NULL,
    "lastLedger" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinancePositionReadModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DisputeReadModel" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "disputeId" BIGINT NOT NULL,
    "milestoneId" BIGINT NOT NULL,
    "milestoneRowId" TEXT NOT NULL,
    "openedBy" TEXT NOT NULL,
    "resolver" TEXT NOT NULL,
    "status" "DisputeStatus" NOT NULL DEFAULT 'OPEN',
    "openedLedger" BIGINT NOT NULL,
    "openedTxHash" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolvedTxHash" TEXT,
    "lastEventId" TEXT NOT NULL,
    "lastLedger" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DisputeReadModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementReadModel" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "milestoneId" BIGINT NOT NULL,
    "orderId" BIGINT NOT NULL,
    "protectedAmount" DECIMAL(39,0) NOT NULL,
    "funderRepayment" DECIMAL(39,0) NOT NULL,
    "supplierPayout" DECIMAL(39,0) NOT NULL,
    "settledLedger" BIGINT NOT NULL,
    "settledTxHash" TEXT NOT NULL,
    "settledAt" TIMESTAMP(3) NOT NULL,
    "lastEventId" TEXT NOT NULL,

    CONSTRAINT "SettlementReadModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefundReadModel" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "milestoneId" BIGINT NOT NULL,
    "orderId" BIGINT NOT NULL,
    "buyer" TEXT NOT NULL,
    "refundedAmount" DECIMAL(39,0) NOT NULL,
    "funderAdvanceOutstanding" DECIMAL(39,0) NOT NULL,
    "refundedLedger" BIGINT NOT NULL,
    "refundedTxHash" TEXT NOT NULL,
    "refundedAt" TIMESTAMP(3) NOT NULL,
    "lastEventId" TEXT NOT NULL,

    CONSTRAINT "RefundReadModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceObject" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "milestoneId" BIGINT,
    "milestoneRowId" TEXT,
    "contentHash" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" BIGINT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "storageDriver" TEXT NOT NULL,
    "uploadedBy" TEXT,
    "documentLabel" TEXT,
    "anchoredOnChain" BOOLEAN NOT NULL DEFAULT false,
    "anchoredAt" TIMESTAMP(3),
    "anchoredTxHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvidenceObject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnchorTransaction" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "anchorDomain" TEXT NOT NULL,
    "direction" "AnchorDirection" NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "anchorTransactionId" TEXT,
    "stellarTxHash" TEXT,
    "sourceAsset" TEXT NOT NULL,
    "sourceAmount" DECIMAL(39,7),
    "destinationAsset" TEXT NOT NULL,
    "destinationAmount" DECIMAL(39,7),
    "status" TEXT NOT NULL,
    "quoteId" TEXT,
    "quoteExpiresAt" TIMESTAMP(3),
    "payoutReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnchorTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IndexedContractEvent_network_contractId_eventId_idx" ON "IndexedContractEvent"("network", "contractId", "eventId");

-- CreateIndex
CREATE INDEX "IndexedContractEvent_eventName_idx" ON "IndexedContractEvent"("eventName");

-- CreateIndex
CREATE INDEX "IndexedContractEvent_ledger_idx" ON "IndexedContractEvent"("ledger");

-- CreateIndex
CREATE UNIQUE INDEX "IndexedContractEvent_network_contractId_eventId_key" ON "IndexedContractEvent"("network", "contractId", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "IndexedContractEvent_network_contractId_ledger_txHash_event_key" ON "IndexedContractEvent"("network", "contractId", "ledger", "txHash", "eventIndex");

-- CreateIndex
CREATE UNIQUE INDEX "IndexerCursor_network_contractId_key" ON "IndexerCursor"("network", "contractId");

-- CreateIndex
CREATE INDEX "OrderReadModel_buyer_idx" ON "OrderReadModel"("buyer");

-- CreateIndex
CREATE INDEX "OrderReadModel_supplier_idx" ON "OrderReadModel"("supplier");

-- CreateIndex
CREATE INDEX "OrderReadModel_status_idx" ON "OrderReadModel"("status");

-- CreateIndex
CREATE UNIQUE INDEX "OrderReadModel_network_contractId_orderId_key" ON "OrderReadModel"("network", "contractId", "orderId");

-- CreateIndex
CREATE INDEX "MilestoneReadModel_orderId_idx" ON "MilestoneReadModel"("orderId");

-- CreateIndex
CREATE INDEX "MilestoneReadModel_status_idx" ON "MilestoneReadModel"("status");

-- CreateIndex
CREATE INDEX "MilestoneReadModel_deadline_idx" ON "MilestoneReadModel"("deadline");

-- CreateIndex
CREATE UNIQUE INDEX "MilestoneReadModel_network_contractId_milestoneId_key" ON "MilestoneReadModel"("network", "contractId", "milestoneId");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceRequestReadModel_milestoneRowId_key" ON "FinanceRequestReadModel"("milestoneRowId");

-- CreateIndex
CREATE INDEX "FinanceRequestReadModel_status_idx" ON "FinanceRequestReadModel"("status");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceRequestReadModel_network_contractId_milestoneId_key" ON "FinanceRequestReadModel"("network", "contractId", "milestoneId");

-- CreateIndex
CREATE INDEX "FundingOfferReadModel_milestoneId_idx" ON "FundingOfferReadModel"("milestoneId");

-- CreateIndex
CREATE INDEX "FundingOfferReadModel_funder_idx" ON "FundingOfferReadModel"("funder");

-- CreateIndex
CREATE INDEX "FundingOfferReadModel_status_idx" ON "FundingOfferReadModel"("status");

-- CreateIndex
CREATE UNIQUE INDEX "FundingOfferReadModel_network_contractId_offerId_key" ON "FundingOfferReadModel"("network", "contractId", "offerId");

-- CreateIndex
CREATE INDEX "FinancePositionReadModel_funder_idx" ON "FinancePositionReadModel"("funder");

-- CreateIndex
CREATE INDEX "FinancePositionReadModel_status_idx" ON "FinancePositionReadModel"("status");

-- CreateIndex
CREATE UNIQUE INDEX "FinancePositionReadModel_network_contractId_milestoneId_off_key" ON "FinancePositionReadModel"("network", "contractId", "milestoneId", "offerId");

-- CreateIndex
CREATE INDEX "DisputeReadModel_milestoneId_idx" ON "DisputeReadModel"("milestoneId");

-- CreateIndex
CREATE INDEX "DisputeReadModel_status_idx" ON "DisputeReadModel"("status");

-- CreateIndex
CREATE UNIQUE INDEX "DisputeReadModel_network_contractId_disputeId_key" ON "DisputeReadModel"("network", "contractId", "disputeId");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementReadModel_network_contractId_milestoneId_key" ON "SettlementReadModel"("network", "contractId", "milestoneId");

-- CreateIndex
CREATE UNIQUE INDEX "RefundReadModel_network_contractId_milestoneId_key" ON "RefundReadModel"("network", "contractId", "milestoneId");

-- CreateIndex
CREATE INDEX "EvidenceObject_milestoneId_idx" ON "EvidenceObject"("milestoneId");

-- CreateIndex
CREATE INDEX "EvidenceObject_anchoredOnChain_idx" ON "EvidenceObject"("anchoredOnChain");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceObject_network_contractId_contentHash_key" ON "EvidenceObject"("network", "contractId", "contentHash");

-- CreateIndex
CREATE INDEX "AnchorTransaction_walletAddress_idx" ON "AnchorTransaction"("walletAddress");

-- CreateIndex
CREATE INDEX "AnchorTransaction_stellarTxHash_idx" ON "AnchorTransaction"("stellarTxHash");

-- CreateIndex
CREATE UNIQUE INDEX "AnchorTransaction_network_anchorDomain_anchorTransactionId_key" ON "AnchorTransaction"("network", "anchorDomain", "anchorTransactionId");

-- AddForeignKey
ALTER TABLE "MilestoneReadModel" ADD CONSTRAINT "MilestoneReadModel_orderRowId_fkey" FOREIGN KEY ("orderRowId") REFERENCES "OrderReadModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceRequestReadModel" ADD CONSTRAINT "FinanceRequestReadModel_milestoneRowId_fkey" FOREIGN KEY ("milestoneRowId") REFERENCES "MilestoneReadModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundingOfferReadModel" ADD CONSTRAINT "FundingOfferReadModel_milestoneRowId_fkey" FOREIGN KEY ("milestoneRowId") REFERENCES "MilestoneReadModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancePositionReadModel" ADD CONSTRAINT "FinancePositionReadModel_milestoneRowId_fkey" FOREIGN KEY ("milestoneRowId") REFERENCES "MilestoneReadModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DisputeReadModel" ADD CONSTRAINT "DisputeReadModel_milestoneRowId_fkey" FOREIGN KEY ("milestoneRowId") REFERENCES "MilestoneReadModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceObject" ADD CONSTRAINT "EvidenceObject_milestoneRowId_fkey" FOREIGN KEY ("milestoneRowId") REFERENCES "MilestoneReadModel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

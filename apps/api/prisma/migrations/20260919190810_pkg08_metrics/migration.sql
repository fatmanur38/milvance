/*
  Warnings:

  - You are about to drop the column `lockedBy` on the `IndexerCursor` table. All the data in the column will be lost.
  - You are about to drop the column `lockedUntil` on the `IndexerCursor` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "LocalPaymentCycleStatus" AS ENUM ('CANDIDATE', 'VERIFIED');

-- AlterTable
ALTER TABLE "IndexerCursor" DROP COLUMN "lockedBy",
DROP COLUMN "lockedUntil";

-- CreateTable
CREATE TABLE "DemoParticipant" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "isTeam" BOOLEAN NOT NULL DEFAULT false,
    "consentToCount" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DemoParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsDaily" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "ordersCreated" INTEGER NOT NULL DEFAULT 0,
    "milestonesFunded" INTEGER NOT NULL DEFAULT 0,
    "advancesFunded" INTEGER NOT NULL DEFAULT 0,
    "milestonesSettled" INTEGER NOT NULL DEFAULT 0,
    "milestonesRefunded" INTEGER NOT NULL DEFAULT 0,
    "disputesOpened" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnalyticsDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LocalPaymentCycleReadModel" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "milestoneId" BIGINT NOT NULL,
    "milestoneRowId" TEXT NOT NULL,
    "anchorTransactionId" TEXT,
    "status" "LocalPaymentCycleStatus" NOT NULL DEFAULT 'CANDIDATE',
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LocalPaymentCycleReadModel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DemoParticipant_network_walletAddress_key" ON "DemoParticipant"("network", "walletAddress");

-- CreateIndex
CREATE UNIQUE INDEX "AnalyticsDaily_network_contractId_day_key" ON "AnalyticsDaily"("network", "contractId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "LocalPaymentCycleReadModel_milestoneRowId_key" ON "LocalPaymentCycleReadModel"("milestoneRowId");

-- CreateIndex
CREATE INDEX "LocalPaymentCycleReadModel_status_idx" ON "LocalPaymentCycleReadModel"("status");

-- CreateIndex
CREATE UNIQUE INDEX "LocalPaymentCycleReadModel_network_contractId_milestoneId_key" ON "LocalPaymentCycleReadModel"("network", "contractId", "milestoneId");

-- AddForeignKey
ALTER TABLE "LocalPaymentCycleReadModel" ADD CONSTRAINT "LocalPaymentCycleReadModel_milestoneRowId_fkey" FOREIGN KEY ("milestoneRowId") REFERENCES "MilestoneReadModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

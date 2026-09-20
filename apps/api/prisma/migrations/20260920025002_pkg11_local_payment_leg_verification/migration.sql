-- CreateEnum
CREATE TYPE "StellarLegStatus" AS ENUM ('UNCHECKED', 'CONFIRMED', 'MISMATCHED', 'UNVERIFIABLE');

-- AlterTable
ALTER TABLE "AnchorTransaction" ADD COLUMN     "stellarLegAt" TIMESTAMP(3),
ADD COLUMN     "stellarLegCheckedAt" TIMESTAMP(3),
ADD COLUMN     "stellarLegDetail" TEXT,
ADD COLUMN     "stellarLegStatus" "StellarLegStatus" NOT NULL DEFAULT 'UNCHECKED';

-- CreateIndex
CREATE INDEX "AnchorTransaction_stellarLegStatus_idx" ON "AnchorTransaction"("stellarLegStatus");

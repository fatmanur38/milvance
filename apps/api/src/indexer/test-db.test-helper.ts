import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../generated/prisma/client';

/**
 * Integration-test database.
 *
 * These tests run against a REAL PostgreSQL, because the properties they assert
 * — unique constraints, transaction rollback, partial indexes — do not exist in
 * a mock. A mocked "unique constraint" would prove nothing about whether
 * duplicate ingestion is actually impossible.
 *
 * Set `TEST_DATABASE_URL` to run them; they skip cleanly when it is absent so a
 * contributor without a database still gets a green `pnpm test`.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
export const hasTestDatabase = TEST_DATABASE_URL !== undefined && TEST_DATABASE_URL !== '';

export function testClient(): PrismaClient {
  if (!hasTestDatabase) {
    throw new Error('TEST_DATABASE_URL is not set');
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL }) });
}

/** Wipe every table so each test starts from a known empty state. */
export async function truncateAll(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "SettlementReadModel",
      "RefundReadModel",
      "DisputeReadModel",
      "FinancePositionReadModel",
      "FundingOfferReadModel",
      "FinanceRequestReadModel",
      "MilestoneReadModel",
      "OrderReadModel",
      "IndexedContractEvent",
      "IndexerCursor",
      "AnalyticsDaily",
      "LocalPaymentCycleReadModel",
      "DemoParticipant",
      "EvidenceObject",
      "EvidenceAnchorReadModel",
      "AnchorTransaction"
    RESTART IDENTITY CASCADE
  `);
}

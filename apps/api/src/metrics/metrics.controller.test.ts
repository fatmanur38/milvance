import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../config';
import type { PrismaService } from '../prisma/prisma.service';
import { ADDRESSES } from '../indexer/fixtures.test-helper';
import {
  hasTestDatabase,
  TEST_DATABASE_URL,
  testClient,
  truncateAll,
} from '../indexer/test-db.test-helper';
import { MetricsController } from './metrics.controller';

const suite = hasTestDatabase ? describe : describe.skip;

suite('public metric aggregation', () => {
  const prisma = hasTestDatabase ? testClient() : (undefined as never);
  const config = loadConfig({
    DATABASE_URL: TEST_DATABASE_URL ?? 'postgresql://localhost/test',
    MILVANCE_CONTRACT_ID: 'CCN6AZHLN2BQPCDZWXJGA3NRJEJ56V5JK3M4VZ5QFKQ3NSJBN6RVTKRX',
    USDC_ISSUER: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    USDC_ASSET_CONTRACT_ID: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  });
  const controller = new MetricsController(prisma as unknown as PrismaService, config);

  beforeEach(async () => {
    await truncateAll(prisma);
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('sums event-backed days and excludes self-reported Anchor metadata', async () => {
    const scope = { network: config.stellar.network, contractId: config.stellar.contractId };
    await prisma.analyticsDaily.createMany({
      data: [
        { ...scope, day: new Date('2026-09-18T00:00:00Z'), ordersCreated: 2, advancesFunded: 1 },
        { ...scope, day: new Date('2026-09-19T00:00:00Z'), ordersCreated: 3, milestonesSettled: 1 },
      ],
    });
    await prisma.anchorTransaction.create({
      data: {
        network: scope.network,
        anchorDomain: 'tr-mock-anchor.fly.dev',
        direction: 'TRY_TO_USDC',
        walletAddress: ADDRESSES.buyer,
        anchorTransactionId: 'reported-1',
        sourceAsset: 'iso4217:TRY',
        destinationAsset: 'USDC',
        status: 'completed',
      },
    });

    const result = await controller.publicMetrics();
    expect(result.ordersCreated).toBe(5);
    expect(result.advancesFunded).toBe(1);
    expect(result.milestonesSettled).toBe(1);
    expect(result.completedLocalPaymentCycles).toBe(0);
  });
});

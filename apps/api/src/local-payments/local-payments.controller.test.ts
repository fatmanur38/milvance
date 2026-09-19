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
import { LocalPaymentsController } from './local-payments.controller';

const suite = hasTestDatabase ? describe : describe.skip;

suite('local-payment metadata ingestion', () => {
  const prisma = hasTestDatabase ? testClient() : (undefined as never);
  const config = loadConfig({
    DATABASE_URL: TEST_DATABASE_URL ?? 'postgresql://localhost/test',
    MILVANCE_CONTRACT_ID: 'CCN6AZHLN2BQPCDZWXJGA3NRJEJ56V5JK3M4VZ5QFKQ3NSJBN6RVTKRX',
    USDC_ISSUER: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    USDC_ASSET_CONTRACT_ID: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  });
  const controller = new LocalPaymentsController(prisma as unknown as PrismaService, config);

  beforeEach(async () => {
    await truncateAll(prisma);
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('upserts the same Anchor ID without inventing a second transfer', async () => {
    const transfer = {
      direction: 'TRY_TO_USDC',
      walletAddress: ADDRESSES.buyer,
      anchorTransactionId: 'anchor-1',
      status: 'pending_anchor',
      sourceAmount: '50.0000000',
      destinationAmount: '2.0000000',
    };
    await controller.record(transfer);
    const result = await controller.record({ ...transfer, status: 'completed' });
    expect(result.verification).toBe('self-reported');
    expect(await prisma.anchorTransaction.count()).toBe(1);
    expect((await controller.list()).transfers[0]?.status).toBe('completed');
    expect((await controller.list()).transfers[0]?.verification).toBe('self-reported');
  });

  it('rejects credentials and records without an idempotency key', async () => {
    await expect(
      controller.record({
        direction: 'TRY_TO_USDC',
        walletAddress: ADDRESSES.buyer,
        jwt: 'secret',
      } as never),
    ).rejects.toThrow(/never stores/);
    await expect(
      controller.record({ direction: 'TRY_TO_USDC', walletAddress: ADDRESSES.buyer }),
    ).rejects.toThrow(/anchorTransactionId/);
    expect(await prisma.anchorTransaction.count()).toBe(0);
  });
});

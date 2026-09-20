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

  it('keeps a browser retry from creating a second conversion', async () => {
    const leg = {
      direction: 'USDC_TO_TRY',
      walletAddress: ADDRESSES.supplier,
      anchorTransactionId: 'sep_retry',
      stellarTxHash: 'a'.repeat(64),
      sourceAmount: '5.0000000',
      destinationAmount: '245.5000000',
      status: 'completed',
    };
    // The panel records after polling; a reload or a double click repeats it.
    await controller.record(leg);
    await controller.record(leg);
    await controller.record(leg);
    expect(await prisma.anchorTransaction.count()).toBe(1);
  });

  it('resets the Stellar verdict when a corrected hash arrives', async () => {
    const leg = {
      direction: 'USDC_TO_TRY',
      walletAddress: ADDRESSES.supplier,
      anchorTransactionId: 'sep_corrected',
      stellarTxHash: 'a'.repeat(64),
      sourceAmount: '5.0000000',
      destinationAmount: '245.5000000',
      status: 'completed',
    };
    await controller.record(leg);
    await prisma.anchorTransaction.updateMany({
      data: { stellarLegStatus: 'CONFIRMED', stellarLegAt: new Date(), stellarLegDetail: 'ok' },
    });

    // A different hash makes the old verdict meaningless: it was about a
    // different transaction. Keeping it would let a wrong hash wear a
    // CONFIRMED badge it never earned.
    await controller.record({ ...leg, stellarTxHash: 'b'.repeat(64) });
    const row = await prisma.anchorTransaction.findFirstOrThrow();
    expect(row.stellarTxHash).toBe('b'.repeat(64));
    expect(row.stellarLegStatus).toBe('UNCHECKED');
    expect(row.stellarLegDetail).toBeNull();
    expect(row.stellarLegAt).toBeNull();
  });

  it('keeps an existing verdict when the same hash is re-posted', async () => {
    const leg = {
      direction: 'USDC_TO_TRY',
      walletAddress: ADDRESSES.supplier,
      anchorTransactionId: 'sep_same',
      stellarTxHash: 'c'.repeat(64),
      sourceAmount: '5.0000000',
      destinationAmount: '245.5000000',
      status: 'completed',
    };
    await controller.record(leg);
    await prisma.anchorTransaction.updateMany({
      data: { stellarLegStatus: 'CONFIRMED', stellarLegAt: new Date('2026-09-20T00:00:00Z') },
    });
    await controller.record(leg);
    const row = await prisma.anchorTransaction.findFirstOrThrow();
    expect(row.stellarLegStatus).toBe('CONFIRMED');
  });

  it('refuses a hash that is not a Stellar transaction hash', async () => {
    await expect(
      controller.record({
        direction: 'USDC_TO_TRY',
        walletAddress: ADDRESSES.supplier,
        anchorTransactionId: 'sep_bad_hash',
        stellarTxHash: 'nope',
        status: 'completed',
      }),
    ).rejects.toThrow(/64-character hex/);
    expect(await prisma.anchorTransaction.count()).toBe(0);
  });

  it('never trusts a recorded leg on its own', async () => {
    await controller.record({
      direction: 'USDC_TO_TRY',
      walletAddress: ADDRESSES.supplier,
      anchorTransactionId: 'sep_unverified',
      stellarTxHash: 'd'.repeat(64),
      sourceAmount: '5.0000000',
      destinationAmount: '245.5000000',
      status: 'completed',
    });
    // Recording is a claim. Nothing about posting it makes Stellar agree.
    const row = await prisma.anchorTransaction.findFirstOrThrow();
    expect(row.stellarLegStatus).toBe('UNCHECKED');
    expect((await controller.list()).transfers[0]?.verification).toBe('self-reported');
  });
});

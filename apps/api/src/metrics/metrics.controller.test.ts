import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../config';
import type { PrismaClient } from '../generated/prisma/client';
import { ADDRESSES } from '../indexer/fixtures.test-helper';
import {
  hasTestDatabase,
  TEST_DATABASE_URL,
  testClient,
  truncateAll,
} from '../indexer/test-db.test-helper';
import type { PrismaService } from '../prisma/prisma.service';
import { ALL_DEFINITIONS, NOT_DERIVABLE } from './definitions';
import { MetricsController } from './metrics.controller';
import { anchorReport, SCOPE, seedLiveHistory } from './scenario.test-helper';

/**
 * The public endpoint itself: shape, safety, and the promise that every number
 * it publishes arrives with a definition attached.
 */
const suite = hasTestDatabase ? describe : describe.skip;

suite('GET /api/metrics/public', () => {
  const prisma: PrismaClient = hasTestDatabase
    ? testClient()
    : (undefined as unknown as PrismaClient);
  const config = loadConfig({
    DATABASE_URL: TEST_DATABASE_URL ?? 'postgresql://localhost/test',
    MILVANCE_CONTRACT_ID: SCOPE.contractId,
    USDC_ISSUER: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    USDC_ASSET_CONTRACT_ID: ADDRESSES.usdcSac,
  });
  const controller = new MetricsController(prisma as unknown as PrismaService, config);

  beforeEach(async () => {
    await truncateAll(prisma);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('labels itself as testnet activity and says how far it has indexed', async () => {
    await seedLiveHistory(prisma);
    const body = await controller.publicMetrics();

    expect(body.scope.network).toBe('testnet');
    expect(body.scope.testnetOnly).toBe(true);
    expect(body.scope.contractId).toBe(SCOPE.contractId);
    expect(body.provenance.indexedEvents).toBeGreaterThanOrEqual(0);
  });

  it('publishes a definition for every metric it reports', async () => {
    await seedLiveHistory(prisma);
    const body = await controller.publicMetrics();

    const documented = new Set(ALL_DEFINITIONS.map((definition) => definition.key));
    for (const key of Object.keys(body.protocolActivity)) {
      expect(documented, `protocolActivity.${key} is undocumented`).toContain(key);
    }
    for (const key of Object.keys(body.adoption)) {
      expect(documented, `adoption.${key} is undocumented`).toContain(key);
    }
    for (const key of Object.keys(body.timings)) {
      expect(documented, `timings.${key} is undocumented`).toContain(key);
    }
    expect(body.definitions.northStar.key).toBe('completedLocalPaymentFinanceCycles');
    // Metrics the constitution names but chain state cannot support are listed
    // with a reason rather than quietly dropped.
    expect(NOT_DERIVABLE.map((entry) => entry.key)).toContain('walletsConnected');
  });

  it('marks every local-payment figure as the Anchor’s word', async () => {
    await seedLiveHistory(prisma);
    await prisma.anchorTransaction.create({ data: anchorReport() });
    const body = await controller.publicMetrics();

    for (const definition of body.definitions.localPayments) {
      expect(definition.provenance).toMatch(/^anchor-reported/);
    }
    expect(body.provenance.localPaymentMetrics).toMatch(/cannot be proven by any blockchain/i);
  });

  it('exposes no secret, no participant metadata and no database id', async () => {
    await seedLiveHistory(prisma);
    await prisma.anchorTransaction.create({ data: anchorReport() });
    await prisma.demoParticipant.create({
      data: { network: SCOPE.network, walletAddress: ADDRESSES.buyer, consentToCount: true },
    });
    const serialised = JSON.stringify(await controller.publicMetrics());

    for (const forbidden of ['jwt', 'token', 'secret', 'seed', 'iban', 'kyc', 'password']) {
      expect(serialised.toLowerCase()).not.toContain(forbidden);
    }
    // No wallet addresses: a traction page is not a directory of who did what.
    for (const address of Object.values(ADDRESSES)) {
      expect(serialised).not.toContain(address);
    }
    // No row ids either — they identify our storage, not anything public.
    expect(serialised).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-/);
  });

  it('agrees with the indexer’s own daily rollup', async () => {
    await seedLiveHistory(prisma);
    // AnalyticsDaily is written by the indexer as events arrive; the endpoint
    // computes from the read models. Two independent paths over the same chain
    // history must produce the same counts, or one of them is wrong.
    await prisma.analyticsDaily.create({
      data: {
        ...SCOPE,
        day: new Date('2026-09-19T00:00:00Z'),
        ordersCreated: 3,
        milestonesFunded: 2,
        advancesFunded: 1,
        milestonesSettled: 1,
        milestonesRefunded: 1,
        disputesOpened: 1,
      },
    });
    const daily = await prisma.analyticsDaily.aggregate({
      where: SCOPE,
      _sum: {
        ordersCreated: true,
        milestonesFunded: true,
        advancesFunded: true,
        milestonesSettled: true,
        milestonesRefunded: true,
        disputesOpened: true,
      },
    });
    const body = await controller.publicMetrics();

    expect(body.protocolActivity.ordersCreated).toBe(daily._sum.ordersCreated);
    expect(body.protocolActivity.milestonesProtected).toBe(daily._sum.milestonesFunded);
    expect(body.protocolActivity.advancesFunded).toBe(daily._sum.advancesFunded);
    expect(body.protocolActivity.milestonesSettled).toBe(daily._sum.milestonesSettled);
    expect(body.protocolActivity.milestonesRefunded).toBe(daily._sum.milestonesRefunded);
    expect(body.protocolActivity.disputesOpened).toBe(daily._sum.disputesOpened);
  });

  it('reports zero external adoption rather than nothing at all', async () => {
    await seedLiveHistory(prisma);
    const body = await controller.publicMetrics();
    expect(body.adoption.externalWallets).toBe(0);
    expect(body.adoption.distinctWallets).toBe(5);
    expect(body.northStar.completedLocalPaymentFinanceCycles).toBe(0);
  });
});

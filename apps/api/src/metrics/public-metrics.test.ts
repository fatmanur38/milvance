import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { PrismaClient } from '../generated/prisma/client';
import { decodeEvent } from '../indexer/decoder';
import { ADDRESSES, rawEvent, resetFixtureSequence } from '../indexer/fixtures.test-helper';
import { projectEvent } from '../indexer/projector';
import { hasTestDatabase, testClient, truncateAll } from '../indexer/test-db.test-helper';
import { deriveCycles, storeCycles } from './local-payment-cycles';
import { computePublicMetrics } from './public-metrics';
import { anchorReport, LIVE, SCOPE, seedLiveHistory } from './scenario.test-helper';

/**
 * Public metrics, computed from the real live history replayed through the
 * real projector.
 *
 * The point of every test here is that a number cannot be produced any other
 * way: not from a form, not from a click, not from an Anchor's say-so, and not
 * from a row someone inserted to make adoption look better.
 */
const suite = hasTestDatabase ? describe : describe.skip;

const OUTSIDER = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

suite('public metrics', () => {
  const prisma: PrismaClient = hasTestDatabase
    ? testClient()
    : (undefined as unknown as PrismaClient);

  beforeEach(async () => {
    resetFixtureSequence();
    await truncateAll(prisma);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('protocol activity', () => {
    it('derives every total from the projected chain history', async () => {
      await seedLiveHistory(prisma);
      const metrics = await computePublicMetrics(prisma, SCOPE);

      expect(metrics.protocolActivity).toMatchObject({
        ordersCreated: 3,
        ordersAccepted: 1,
        ordersCompleted: 1,
        milestonesCreated: 3,
        milestonesProtected: 2,
        financeRequests: 1,
        fundingOffers: 1,
        advancesFunded: 1,
        milestonesSettled: 1,
        disputesOpened: 1,
        milestonesRefunded: 1,
        distinctWallets: 5,
      });
    });

    it('counts escrow that has already been released, not just escrow still held', async () => {
      await seedLiveHistory(prisma);
      const metrics = await computePublicMetrics(prisma, SCOPE);

      // Both milestones of order 2 were protected with 10 USDC and both are now
      // terminal, so their live fundedAmount is zero. Summing that column alone
      // would report zero protected volume and erase the whole demo.
      const held = await prisma.milestoneReadModel.aggregate({
        where: SCOPE,
        _sum: { fundedAmount: true },
      });
      expect(held._sum.fundedAmount?.toFixed(0)).toBe('0');
      expect(metrics.protocolActivity.protectedVolume).toBe((LIVE.protectedEach * 2n).toString());
    });

    it('keeps buyer escrow and funder advance as separate money', async () => {
      await seedLiveHistory(prisma);
      const metrics = await computePublicMetrics(prisma, SCOPE);

      expect(metrics.protocolActivity.advanceVolume).toBe(LIVE.principal.toString());
      expect(metrics.protocolActivity.funderRepaymentVolume).toBe(LIVE.repayment.toString());
      expect(metrics.protocolActivity.supplierResidualVolume).toBe(LIVE.supplierPayout.toString());
      // Settled escrow is exactly what the contract released, and the advance is
      // never added into it.
      expect(
        BigInt(metrics.protocolActivity.funderRepaymentVolume as string) +
          BigInt(metrics.protocolActivity.supplierResidualVolume as string),
      ).toBe(LIVE.protectedEach);
      expect(metrics.protocolActivity.refundVolume).toBe(LIVE.protectedEach.toString());
    });

    it('publishes money as exact integer base units, never a float', async () => {
      await seedLiveHistory(prisma);
      const metrics = await computePublicMetrics(prisma, SCOPE);

      for (const key of [
        'protectedVolume',
        'advanceVolume',
        'funderRepaymentVolume',
        'supplierResidualVolume',
        'refundVolume',
      ]) {
        const value = metrics.protocolActivity[key];
        expect(typeof value).toBe('string');
        // Integer base units only: a decimal point here would mean something
        // formatted a figure before it was aggregated.
        expect(value).toMatch(/^\d+$/);
      }
    });

    it('survives an indexer replay with identical totals', async () => {
      await seedLiveHistory(prisma);
      const before = await computePublicMetrics(prisma, SCOPE);

      // What `indexer replay` does: drop the derived rows, then rebuild from the
      // same chain events.
      await prisma.settlementReadModel.deleteMany({ where: SCOPE });
      await prisma.refundReadModel.deleteMany({ where: SCOPE });
      await prisma.disputeReadModel.deleteMany({ where: SCOPE });
      await prisma.financePositionReadModel.deleteMany({ where: SCOPE });
      await prisma.fundingOfferReadModel.deleteMany({ where: SCOPE });
      await prisma.financeRequestReadModel.deleteMany({ where: SCOPE });
      await prisma.milestoneReadModel.deleteMany({ where: SCOPE });
      await prisma.orderReadModel.deleteMany({ where: SCOPE });
      resetFixtureSequence();
      await seedLiveHistory(prisma);

      expect(await computePublicMetrics(prisma, SCOPE)).toEqual(before);
    });

    it('does not double count when the same event is projected twice', async () => {
      await seedLiveHistory(prisma);
      await projectEvent(
        prisma,
        SCOPE,
        decodeEvent(
          rawEvent('milestone_created', {
            order_id: 2n,
            milestone_id: 4n,
            index: 2,
            amount: LIVE.protectedEach,
            deadline: null,
          }),
        ),
      );
      // Built after the milestone exists, so it is the newest event rather than
      // an out-of-order one the projector would skip for a different reason.
      const funding = rawEvent('milestone_funded', {
        order_id: 2n,
        milestone_id: 4n,
        buyer: ADDRESSES.buyer,
        amount: LIVE.protectedEach,
        funded_amount: LIVE.protectedEach,
        fully_funded: true,
      });
      await projectEvent(prisma, SCOPE, decodeEvent(funding));
      const once = await computePublicMetrics(prisma, SCOPE);

      // The very same event, arriving again. Projections are monotonic in the
      // event id, so escrow must not accumulate a second time.
      await projectEvent(prisma, SCOPE, decodeEvent(funding));

      expect(await computePublicMetrics(prisma, SCOPE)).toEqual(once);
      expect(once.protocolActivity.protectedVolume).toBe((LIVE.protectedEach * 3n).toString());
    });
  });

  describe('external adoption', () => {
    it('is zero when nobody has been classified, and never guesses', async () => {
      await seedLiveHistory(prisma);
      const metrics = await computePublicMetrics(prisma, SCOPE);

      expect(metrics.adoption).toEqual({
        externalWallets: 0,
        teamWallets: 0,
        unclassifiedWallets: 5,
        distinctWallets: 5,
      });
    });

    it('excludes a wallet its owner declared as team', async () => {
      await seedLiveHistory(prisma);
      await prisma.demoParticipant.create({
        data: {
          network: SCOPE.network,
          walletAddress: ADDRESSES.buyer,
          isTeam: true,
          consentToCount: true,
        },
      });
      const metrics = await computePublicMetrics(prisma, SCOPE);

      // Consenting to be counted does not make a team wallet external.
      expect(metrics.adoption.externalWallets).toBe(0);
      expect(metrics.adoption.teamWallets).toBe(1);
      expect(metrics.adoption.unclassifiedWallets).toBe(4);
    });

    it('counts a consenting non-team wallet only once it is active on chain', async () => {
      await seedLiveHistory(prisma);
      await prisma.demoParticipant.create({
        data: {
          network: SCOPE.network,
          walletAddress: OUTSIDER,
          isTeam: false,
          consentToCount: true,
        },
      });
      // Tagged, but this wallet appears nowhere in chain state: a consent row is
      // not evidence of use.
      expect((await computePublicMetrics(prisma, SCOPE)).adoption.externalWallets).toBe(0);

      await projectEvent(
        prisma,
        SCOPE,
        decodeEvent(
          rawEvent('order_created', {
            order_id: 4n,
            buyer: OUTSIDER,
            supplier: ADDRESSES.supplier,
            attestor: ADDRESSES.attestor,
            resolver: ADDRESSES.resolver,
            asset: ADDRESSES.usdcSac,
          }),
        ),
      );
      const after = await computePublicMetrics(prisma, SCOPE);
      expect(after.adoption.externalWallets).toBe(1);
      expect(after.adoption.distinctWallets).toBe(6);
    });

    it('does not count a wallet that never consented', async () => {
      await seedLiveHistory(prisma);
      await prisma.demoParticipant.create({
        data: {
          network: SCOPE.network,
          walletAddress: ADDRESSES.supplier,
          isTeam: false,
          consentToCount: false,
        },
      });
      expect((await computePublicMetrics(prisma, SCOPE)).adoption.externalWallets).toBe(0);
    });

    it('keeps the three buckets adding up to the total', async () => {
      await seedLiveHistory(prisma);
      await prisma.demoParticipant.createMany({
        data: [
          { network: SCOPE.network, walletAddress: ADDRESSES.buyer, isTeam: true },
          { network: SCOPE.network, walletAddress: ADDRESSES.supplier, isTeam: true },
        ],
      });
      const { adoption } = await computePublicMetrics(prisma, SCOPE);
      expect(adoption.externalWallets + adoption.teamWallets + adoption.unclassifiedWallets).toBe(
        adoption.distinctWallets,
      );
    });
  });

  describe('local payments', () => {
    it('reports conversions as the Anchor’s word until Stellar confirms them', async () => {
      await seedLiveHistory(prisma);
      await prisma.anchorTransaction.create({ data: anchorReport() });
      const metrics = await computePublicMetrics(prisma, SCOPE);

      expect(metrics.localPayments).toMatchObject({
        onRampsReported: 1,
        offRampsReported: 0,
        legsChainConfirmed: 0,
        legsUnchecked: 1,
        tryOnboarded: '1000.0000000',
        tryPaidToSuppliers: '0.0000000',
      });
    });

    it('keeps fiat precision exactly as recorded', async () => {
      await prisma.anchorTransaction.createMany({
        data: [
          anchorReport({ sourceAmount: '1000.1200000' }),
          anchorReport({ sourceAmount: '0.0000001' }),
          anchorReport({ sourceAmount: '2500.3300000' }),
        ],
      });
      const metrics = await computePublicMetrics(prisma, SCOPE);
      // 1000.12 + 0.0000001 + 2500.33 — a float would land on ...4500000001.
      expect(metrics.localPayments.tryOnboarded).toBe('3500.4500001');
    });

    it('counts a direction only for the rows that have it', async () => {
      await prisma.anchorTransaction.createMany({
        data: [
          anchorReport({ direction: 'USDC_TO_TRY', destinationAmount: '245.5000000' }),
          anchorReport({ direction: 'USDC_TO_TRY', destinationAmount: '100.0000000' }),
          anchorReport({ direction: 'TRY_TO_USDC', sourceAmount: '500.0000000' }),
        ],
      });
      const metrics = await computePublicMetrics(prisma, SCOPE);
      expect(metrics.localPayments.offRampsReported).toBe(2);
      expect(metrics.localPayments.onRampsReported).toBe(1);
      expect(metrics.localPayments.tryPaidToSuppliers).toBe('345.5000000');
      expect(metrics.localPayments.tryOnboarded).toBe('500.0000000');
    });

    it('ignores reports that never completed', async () => {
      await prisma.anchorTransaction.create({
        data: anchorReport({ status: 'pending_user_transfer_start', sourceAmount: '900.0000000' }),
      });
      const metrics = await computePublicMetrics(prisma, SCOPE);
      expect(metrics.localPayments.onRampsReported).toBe(0);
      expect(metrics.localPayments.tryOnboarded).toBe('0.0000000');
    });

    it('publishes contradicted reports rather than hiding them', async () => {
      await prisma.anchorTransaction.create({
        data: {
          ...anchorReport(),
          stellarLegStatus: 'MISMATCHED',
          stellarLegDetail: 'pays a different wallet',
        },
      });
      const metrics = await computePublicMetrics(prisma, SCOPE);
      expect(metrics.localPayments.legsMismatched).toBe(1);
      expect(metrics.localPayments.legsChainConfirmed).toBe(0);
    });
  });

  describe('completed local-payment finance cycles', () => {
    it('does not count a cycle whose local-payment leg is only self-reported', async () => {
      await seedLiveHistory(prisma);
      await prisma.anchorTransaction.create({ data: anchorReport() });
      const metrics = await computePublicMetrics(prisma, SCOPE);

      expect(metrics.northStar.completedLocalPaymentFinanceCycles).toBe(0);
      expect(metrics.northStar.candidateCycles).toBe(1);
      expect(metrics.northStar.cycles[0]?.missing).toContain(
        'no local-money conversion is confirmed on Stellar for a party to this trade',
      );
    });

    it('counts a cycle once every leg is real, and counts it exactly once', async () => {
      await seedLiveHistory(prisma);
      const position = await prisma.financePositionReadModel.findFirstOrThrow({ where: SCOPE });
      await prisma.anchorTransaction.create({
        data: {
          ...anchorReport({ direction: 'USDC_TO_TRY', walletAddress: ADDRESSES.supplier }),
          stellarLegStatus: 'CONFIRMED',
          stellarLegAt: new Date(position.fundedAt.getTime() + 60_000),
        },
      });
      const metrics = await computePublicMetrics(prisma, SCOPE);

      expect(metrics.northStar.completedLocalPaymentFinanceCycles).toBe(1);
      expect(metrics.northStar.supplierOffRampCycles).toBe(1);
      expect(metrics.northStar.cycles.filter((cycle) => cycle.counted)).toHaveLength(1);
    });

    it('does not count a supplier off-ramp that happened before the advance existed', async () => {
      await seedLiveHistory(prisma);
      const position = await prisma.financePositionReadModel.findFirstOrThrow({ where: SCOPE });
      await prisma.anchorTransaction.create({
        data: {
          ...anchorReport({ direction: 'USDC_TO_TRY', walletAddress: ADDRESSES.supplier }),
          stellarLegStatus: 'CONFIRMED',
          stellarLegAt: new Date(position.fundedAt.getTime() - 60_000),
        },
      });
      expect(
        (await computePublicMetrics(prisma, SCOPE)).northStar.completedLocalPaymentFinanceCycles,
      ).toBe(0);
    });

    it('does not count a financed milestone that never settled', async () => {
      await seedLiveHistory(prisma);
      await prisma.settlementReadModel.deleteMany({ where: SCOPE });
      await prisma.anchorTransaction.create({
        data: {
          ...anchorReport({ direction: 'USDC_TO_TRY', walletAddress: ADDRESSES.supplier }),
          stellarLegStatus: 'CONFIRMED',
          stellarLegAt: new Date('2030-01-01T00:00:00Z'),
        },
      });
      const metrics = await computePublicMetrics(prisma, SCOPE);
      expect(metrics.northStar.completedLocalPaymentFinanceCycles).toBe(0);
      expect(metrics.northStar.cycles[0]?.missing).toContain(
        'the milestone has not settled on chain',
      );
    });

    it('does not count a settled milestone that was never financed', async () => {
      await seedLiveHistory(prisma);
      // Milestone 3 settled nothing and was never advanced against; a confirmed
      // conversion by its buyer must not conjure a finance cycle.
      await prisma.financePositionReadModel.deleteMany({ where: SCOPE });
      await prisma.anchorTransaction.create({
        data: { ...anchorReport(), stellarLegStatus: 'CONFIRMED', stellarLegAt: new Date(0) },
      });
      const metrics = await computePublicMetrics(prisma, SCOPE);
      expect(metrics.northStar.candidateCycles).toBe(0);
      expect(metrics.northStar.completedLocalPaymentFinanceCycles).toBe(0);
    });

    it('never exposes a wallet address in the public cycle record', async () => {
      await seedLiveHistory(prisma);
      await prisma.anchorTransaction.create({ data: anchorReport() });
      const metrics = await computePublicMetrics(prisma, SCOPE);
      const serialised = JSON.stringify(metrics.northStar);
      for (const address of Object.values(ADDRESSES)) {
        expect(serialised).not.toContain(address);
      }
    });

    it('stores cycles idempotently, so re-running converges', async () => {
      await seedLiveHistory(prisma);
      const cycles = await deriveCycles(prisma, SCOPE);
      await storeCycles(prisma, SCOPE, cycles);
      await storeCycles(prisma, SCOPE, cycles);
      expect(await prisma.localPaymentCycleReadModel.count()).toBe(1);
      const row = await prisma.localPaymentCycleReadModel.findFirstOrThrow();
      expect(row.status).toBe('CANDIDATE');
    });
  });

  describe('the write surface', () => {
    it('cannot touch a single chain-derived financial row', async () => {
      await seedLiveHistory(prisma);
      await prisma.anchorTransaction.create({ data: anchorReport() });
      const before = await financialSnapshot(prisma);

      // Everything PKG-11 is allowed to write: a Stellar verdict on an Anchor
      // report, and the derived cycle rows.
      await prisma.anchorTransaction.updateMany({
        where: { network: SCOPE.network },
        data: { stellarLegStatus: 'CONFIRMED', stellarLegAt: new Date() },
      });
      await storeCycles(prisma, SCOPE, await deriveCycles(prisma, SCOPE));
      await computePublicMetrics(prisma, SCOPE);

      expect(await financialSnapshot(prisma)).toEqual(before);
    });
  });

  describe('timings', () => {
    it('measures order completion between chain timestamps', async () => {
      await seedLiveHistory(prisma);
      const metrics = await computePublicMetrics(prisma, SCOPE);
      // One completed order, so the median is that order's own duration.
      expect(metrics.timings.medianOrderCompletionSeconds).toBeGreaterThan(0);
    });

    it('has no time-to-local-cash until a supplier off-ramp is confirmed', async () => {
      await seedLiveHistory(prisma);
      await prisma.anchorTransaction.create({ data: anchorReport() });
      expect((await computePublicMetrics(prisma, SCOPE)).timings.medianTimeToLocalCashSeconds).toBe(
        null,
      );
    });
  });
});

/** Every chain-derived table, as a comparable fingerprint. */
async function financialSnapshot(prisma: PrismaClient) {
  const [orders, milestones, offers, positions, requests, settlements, refunds, disputes, events] =
    await Promise.all([
      prisma.orderReadModel.findMany({ orderBy: { orderId: 'asc' } }),
      prisma.milestoneReadModel.findMany({ orderBy: { milestoneId: 'asc' } }),
      prisma.fundingOfferReadModel.findMany(),
      prisma.financePositionReadModel.findMany(),
      prisma.financeRequestReadModel.findMany(),
      prisma.settlementReadModel.findMany(),
      prisma.refundReadModel.findMany(),
      prisma.disputeReadModel.findMany(),
      prisma.indexedContractEvent.findMany({ orderBy: { eventId: 'asc' } }),
    ]);
  return JSON.parse(
    JSON.stringify(
      { orders, milestones, offers, positions, requests, settlements, refunds, disputes, events },
      (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
    ),
  ) as unknown;
}

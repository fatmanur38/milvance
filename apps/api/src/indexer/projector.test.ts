import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { PrismaClient } from '../generated/prisma/client';
import type { ApiConfig } from '../config';
import type { PrismaService } from '../prisma/prisma.service';
import { ReadController } from '../read/read.controller';
import type { ReconcileService } from '../read/reconcile.service';
import { decodeEvent } from './decoder';
import {
  ADDRESSES,
  CONTRACT_ID,
  NETWORK,
  rawEvent,
  resetFixtureSequence,
} from './fixtures.test-helper';
import { projectEvent, type ProjectionContext } from './projector';
import { hasTestDatabase, testClient, truncateAll } from './test-db.test-helper';

/**
 * Projection tests against a real PostgreSQL.
 *
 * The invariants under test — unique constraints, the partial index that allows
 * one ACTIVE finance position per milestone, and CHECK constraints on escrow —
 * live in the database. Asserting them against a mock would prove nothing.
 */
const suite = hasTestDatabase ? describe : describe.skip;

const CTX: ProjectionContext = { network: NETWORK, contractId: CONTRACT_ID };

suite('event projection', () => {
  const prisma: PrismaClient = hasTestDatabase
    ? testClient()
    : (undefined as unknown as PrismaClient);

  beforeEach(async () => {
    resetFixtureSequence();
    await truncateAll(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  const apply = async (name: string, fields: Record<string, unknown>, overrides = {}) => {
    const event = decodeEvent(rawEvent(name, fields, overrides));
    const projected = await projectEvent(prisma, CTX, event);
    return { event, projected };
  };

  const createOrder = (orderId = 1n) =>
    apply('order_created', {
      order_id: orderId,
      buyer: ADDRESSES.buyer,
      supplier: ADDRESSES.supplier,
      attestor: ADDRESSES.attestor,
      resolver: ADDRESSES.resolver,
      asset: ADDRESSES.usdcSac,
    });

  const createMilestone = (milestoneId = 1n, amount = 10_000_0000000n) =>
    apply('milestone_created', {
      order_id: 1n,
      milestone_id: milestoneId,
      index: 0,
      amount,
      deadline: null,
    });

  describe('orders', () => {
    it('refuses an accepted order whose creation event was missed', async () => {
      await expect(
        apply('order_accepted', { order_id: 1n, supplier: ADDRESSES.supplier }),
      ).rejects.toThrow(/has no projection/);
      expect(await prisma.orderReadModel.count()).toBe(0);
    });

    it('projects order_created with the contract’s own field names', async () => {
      await createOrder();

      const order = await prisma.orderReadModel.findFirstOrThrow();
      expect(order.orderId).toBe(1n);
      expect(order.buyer).toBe(ADDRESSES.buyer);
      expect(order.attestor).toBe(ADDRESSES.attestor);
      expect(order.resolver).toBe(ADDRESSES.resolver);
      expect(order.asset).toBe(ADDRESSES.usdcSac);
      expect(order.status).toBe('CREATED');
    });

    it('advances through accept and complete', async () => {
      await createOrder();
      await apply('order_accepted', { order_id: 1n, supplier: ADDRESSES.supplier });
      expect((await prisma.orderReadModel.findFirstOrThrow()).status).toBe('ACTIVE');

      await apply('order_completed', { order_id: 1n });
      expect((await prisma.orderReadModel.findFirstOrThrow()).status).toBe('COMPLETED');
    });

    it('is idempotent: replaying order_created creates no second row', async () => {
      const first = decodeEvent(
        rawEvent('order_created', {
          order_id: 1n,
          buyer: ADDRESSES.buyer,
          supplier: ADDRESSES.supplier,
          attestor: ADDRESSES.attestor,
          resolver: ADDRESSES.resolver,
          asset: ADDRESSES.usdcSac,
        }),
      );
      await projectEvent(prisma, CTX, first);
      await projectEvent(prisma, CTX, first);
      await projectEvent(prisma, CTX, first);

      expect(await prisma.orderReadModel.count()).toBe(1);
    });
  });

  describe('milestones and buyer escrow', () => {
    it('records funded_amount as the cumulative total the contract published', async () => {
      await createOrder();
      await createMilestone();

      await apply('milestone_funded', {
        order_id: 1n,
        milestone_id: 1n,
        buyer: ADDRESSES.buyer,
        amount: 4_000_0000000n,
        funded_amount: 4_000_0000000n,
        fully_funded: false,
      });
      let milestone = await prisma.milestoneReadModel.findFirstOrThrow();
      expect(milestone.fundedAmount.toFixed(0)).toBe('40000000000');
      expect(milestone.status).toBe('UNFUNDED');

      await apply('milestone_funded', {
        order_id: 1n,
        milestone_id: 1n,
        buyer: ADDRESSES.buyer,
        amount: 6_000_0000000n,
        funded_amount: 10_000_0000000n,
        fully_funded: true,
      });
      milestone = await prisma.milestoneReadModel.findFirstOrThrow();
      expect(milestone.fundedAmount.toFixed(0)).toBe('100000000000');
      expect(milestone.status).toBe('FUNDED');
    });

    it('does not double-count escrow when a funding event is replayed', async () => {
      await createOrder();
      await createMilestone();
      const funded = decodeEvent(
        rawEvent('milestone_funded', {
          order_id: 1n,
          milestone_id: 1n,
          buyer: ADDRESSES.buyer,
          amount: 10_000_0000000n,
          funded_amount: 10_000_0000000n,
          fully_funded: true,
        }),
      );

      await projectEvent(prisma, CTX, funded);
      await projectEvent(prisma, CTX, funded);

      // The projection copies the contract's cumulative total; it never adds a
      // delta, which is why replay cannot inflate escrow.
      const milestone = await prisma.milestoneReadModel.findFirstOrThrow();
      expect(milestone.fundedAmount.toFixed(0)).toBe('100000000000');
    });

    it('returns escrow to zero on partial_funding_cancelled', async () => {
      await createOrder();
      await createMilestone();
      await apply('milestone_funded', {
        order_id: 1n,
        milestone_id: 1n,
        buyer: ADDRESSES.buyer,
        amount: 3_000_0000000n,
        funded_amount: 3_000_0000000n,
        fully_funded: false,
      });
      await apply('partial_funding_cancelled', {
        order_id: 1n,
        milestone_id: 1n,
        buyer: ADDRESSES.buyer,
        amount: 3_000_0000000n,
      });

      const milestone = await prisma.milestoneReadModel.findFirstOrThrow();
      expect(milestone.fundedAmount.toFixed(0)).toBe('0');
      expect(milestone.status).toBe('UNFUNDED');
    });

    it('refuses a milestone event whose milestone was never projected', async () => {
      await createOrder();

      // Starting the stream too late would otherwise invent `amount` and
      // `orderId` out of nothing.
      await expect(
        apply('milestone_funded', {
          order_id: 1n,
          milestone_id: 99n,
          buyer: ADDRESSES.buyer,
          amount: 1n,
          funded_amount: 1n,
          fully_funded: true,
        }),
      ).rejects.toThrow(/replay from the contract/);
    });

    it('preserves exact i128 precision through the database', async () => {
      await createOrder();
      const huge = 170_141_183_460_469_231_731_687_303_715_884_105_727n;
      await createMilestone(1n, huge);

      const milestone = await prisma.milestoneReadModel.findFirstOrThrow();
      expect(milestone.amount.toFixed(0)).toBe(huge.toString());
      // The value a JS number would have mangled.
      expect(BigInt(milestone.amount.toFixed(0))).toBe(huge);
    });
  });

  describe('financing', () => {
    const setUpFinanced = async () => {
      await createOrder();
      await createMilestone();
      await apply('milestone_funded', {
        order_id: 1n,
        milestone_id: 1n,
        buyer: ADDRESSES.buyer,
        amount: 10_000_0000000n,
        funded_amount: 10_000_0000000n,
        fully_funded: true,
      });
      await apply('finance_requested', {
        milestone_id: 1n,
        supplier: ADDRESSES.supplier,
        requested_principal: 7_000_0000000n,
        protected_amount: 10_000_0000000n,
        expires_at: 1_790_000_000n,
      });
      await apply('funding_offer_created', {
        milestone_id: 1n,
        offer_id: 1n,
        funder: ADDRESSES.funder,
        principal: 7_000_0000000n,
        repayment: 7_350_0000000n,
        expires_at: 1_790_000_000n,
      });
      await apply('offer_accepted', {
        milestone_id: 1n,
        offer_id: 1n,
        funder: ADDRESSES.funder,
        principal: 7_000_0000000n,
        repayment: 7_350_0000000n,
      });
      await apply('advance_funded', {
        milestone_id: 1n,
        offer_id: 1n,
        funder: ADDRESSES.funder,
        supplier: ADDRESSES.supplier,
        principal: 7_000_0000000n,
        repayment: 7_350_0000000n,
        protected_amount: 10_000_0000000n,
      });
    };

    it('projects the full request -> offer -> acceptance -> advance path', async () => {
      await setUpFinanced();

      expect((await prisma.financeRequestReadModel.findFirstOrThrow()).status).toBe('ACCEPTED');
      expect((await prisma.fundingOfferReadModel.findFirstOrThrow()).status).toBe('FUNDED');
      const position = await prisma.financePositionReadModel.findFirstOrThrow();
      expect(position.status).toBe('ACTIVE');
      expect(position.principal.toFixed(0)).toBe('70000000000');
      expect((await prisma.milestoneReadModel.findFirstOrThrow()).status).toBe('FINANCED');
    });

    it('keeps buyer escrow untouched by the funder advance', async () => {
      await setUpFinanced();

      const milestone = await prisma.milestoneReadModel.findFirstOrThrow();
      const position = await prisma.financePositionReadModel.findFirstOrThrow();

      // The advance moved funder -> supplier. Escrow still holds the full
      // protected amount, exactly as it did before funding.
      expect(milestone.fundedAmount.toFixed(0)).toBe('100000000000');
      expect(position.protectedAmountAtFunding.toFixed(0)).toBe('100000000000');
      expect(position.principal.toFixed(0)).not.toBe(milestone.fundedAmount.toFixed(0));
    });

    it('lets the database refuse a second ACTIVE position for one milestone', async () => {
      await setUpFinanced();

      // Invariant 1, enforced by a partial unique index rather than by trust.
      await expect(
        prisma.financePositionReadModel.create({
          data: {
            network: NETWORK,
            contractId: CONTRACT_ID,
            milestoneId: 1n,
            offerId: 2n,
            milestoneRowId: (await prisma.milestoneReadModel.findFirstOrThrow()).id,
            funder: ADDRESSES.funder,
            supplier: ADDRESSES.supplier,
            principal: '1',
            repayment: '1',
            protectedAmountAtFunding: '1',
            status: 'ACTIVE',
            fundedLedger: 1n,
            fundedTxHash: 'x'.repeat(64),
            fundedAt: new Date(),
            lastEventId: 'z',
            lastLedger: 1n,
          },
        }),
      ).rejects.toThrow();
    });

    it('reopens the request when an accepted offer expires unfunded', async () => {
      await createOrder();
      await createMilestone();
      await apply('milestone_funded', {
        order_id: 1n,
        milestone_id: 1n,
        buyer: ADDRESSES.buyer,
        amount: 10_000_0000000n,
        funded_amount: 10_000_0000000n,
        fully_funded: true,
      });
      await apply('finance_requested', {
        milestone_id: 1n,
        supplier: ADDRESSES.supplier,
        requested_principal: 7_000_0000000n,
        protected_amount: 10_000_0000000n,
        expires_at: 1_790_000_000n,
      });
      await apply('funding_offer_created', {
        milestone_id: 1n,
        offer_id: 1n,
        funder: ADDRESSES.funder,
        principal: 7_000_0000000n,
        repayment: 7_350_0000000n,
        expires_at: 1_790_000_000n,
      });
      await apply('offer_accepted', {
        milestone_id: 1n,
        offer_id: 1n,
        funder: ADDRESSES.funder,
        principal: 7_000_0000000n,
        repayment: 7_350_0000000n,
      });
      await apply('acceptance_released', {
        milestone_id: 1n,
        offer_id: 1n,
        supplier: ADDRESSES.supplier,
        funder: ADDRESSES.funder,
        request_reopened: true,
      });

      expect((await prisma.financeRequestReadModel.findFirstOrThrow()).status).toBe('OPEN');
      expect((await prisma.milestoneReadModel.findFirstOrThrow()).status).toBe('FINANCE_REQUESTED');
      // No position was ever created: no funder capital moved.
      expect(await prisma.financePositionReadModel.count()).toBe(0);
    });

    it('returns the milestone to FUNDED when the finance request is cancelled', async () => {
      await createOrder();
      await createMilestone();
      await apply('milestone_funded', {
        order_id: 1n,
        milestone_id: 1n,
        buyer: ADDRESSES.buyer,
        amount: 10_000_0000000n,
        funded_amount: 10_000_0000000n,
        fully_funded: true,
      });
      await apply('finance_requested', {
        milestone_id: 1n,
        supplier: ADDRESSES.supplier,
        requested_principal: 7_000_0000000n,
        protected_amount: 10_000_0000000n,
        expires_at: 1_790_000_000n,
      });
      await apply('finance_request_cancelled', {
        milestone_id: 1n,
        supplier: ADDRESSES.supplier,
        was_expired: true,
      });

      const milestone = await prisma.milestoneReadModel.findFirstOrThrow();
      expect(milestone.status).toBe('FUNDED');
      // Still fully protected; it simply stopped seeking financing.
      expect(milestone.fundedAmount.toFixed(0)).toBe('100000000000');
      const request = await prisma.financeRequestReadModel.findFirstOrThrow();
      expect(request.status).toBe('CANCELLED');
      expect(request.cancelledWhileExpired).toBe(true);
    });
  });

  describe('evidence, settlement, refund and dispute', () => {
    const digest = 'c'.repeat(64);

    const seedActivePosition = async () => {
      const milestone = await prisma.milestoneReadModel.findFirstOrThrow();
      await prisma.financePositionReadModel.create({
        data: {
          network: NETWORK,
          contractId: CONTRACT_ID,
          milestoneId: 1n,
          offerId: 1n,
          milestoneRowId: milestone.id,
          funder: ADDRESSES.funder,
          supplier: ADDRESSES.supplier,
          principal: '70000000000',
          repayment: '73500000000',
          protectedAmountAtFunding: '100000000000',
          status: 'ACTIVE',
          fundedLedger: milestone.createdLedger,
          fundedTxHash: milestone.createdTxHash,
          fundedAt: milestone.createdAt,
          lastEventId: milestone.lastEventId,
          lastLedger: milestone.lastLedger,
        },
      });
    };

    const setUpSubmitted = async () => {
      await createOrder();
      await createMilestone();
      await apply('milestone_funded', {
        order_id: 1n,
        milestone_id: 1n,
        buyer: ADDRESSES.buyer,
        amount: 10_000_0000000n,
        funded_amount: 10_000_0000000n,
        fully_funded: true,
      });
      await apply('evidence_submitted', {
        milestone_id: 1n,
        supplier: ADDRESSES.supplier,
        evidence_hash: digest,
        replaced_previous: false,
      });
    };

    it('records only the digest, never a document', async () => {
      await setUpSubmitted();

      const milestone = await prisma.milestoneReadModel.findFirstOrThrow();
      expect(milestone.evidenceHash).toBe(digest);
      expect(milestone.status).toBe('SUBMITTED');
    });

    it('marks previously uploaded evidence metadata as anchored', async () => {
      await prisma.evidenceObject.create({
        data: {
          network: NETWORK,
          contractId: CONTRACT_ID,
          contentHash: digest,
          filename: 'bill-of-lading.pdf',
          mimeType: 'application/pdf',
          byteSize: 1024n,
          storageKey: `evidence/cc/cc/${digest}`,
          storageDriver: 'local-dev',
        },
      });
      await setUpSubmitted();

      const object = await prisma.evidenceObject.findFirstOrThrow();
      expect(object.anchoredOnChain).toBe(true);
      const anchor = await prisma.evidenceAnchorReadModel.findFirstOrThrow();
      expect(anchor.milestoneId).toBe(1n);
      expect(anchor.contentHash).toBe(digest);
    });

    it('keeps reused and replaced evidence commitments scoped to each milestone', async () => {
      await createOrder();
      await createMilestone(1n);
      await createMilestone(2n);
      await prisma.evidenceObject.create({
        data: {
          network: NETWORK,
          contractId: CONTRACT_ID,
          contentHash: digest,
          filename: 'shared-qc.pdf',
          mimeType: 'application/pdf',
          byteSize: 10n,
          storageKey: `evidence/cc/cc/${digest}`,
          storageDriver: 'local-dev',
        },
      });
      for (const milestoneId of [1n, 2n]) {
        await apply('evidence_submitted', {
          milestone_id: milestoneId,
          supplier: ADDRESSES.supplier,
          evidence_hash: digest,
          replaced_previous: false,
        });
      }
      expect(await prisma.evidenceAnchorReadModel.count()).toBe(2);

      const replacement = 'd'.repeat(64);
      await apply('evidence_submitted', {
        milestone_id: 1n,
        supplier: ADDRESSES.supplier,
        evidence_hash: replacement,
        replaced_previous: true,
      });
      const anchors = await prisma.evidenceAnchorReadModel.findMany({
        orderBy: { milestoneId: 'asc' },
      });
      expect(anchors.map((anchor) => anchor.contentHash)).toEqual([replacement, digest]);
      expect(
        (await prisma.milestoneReadModel.findFirstOrThrow({ where: { milestoneId: 1n } }))
          .evidenceHash,
      ).toBe(replacement);
      const reader = new ReadController(
        prisma as unknown as PrismaService,
        {} as ReconcileService,
        { stellar: { network: NETWORK, contractId: CONTRACT_ID } } as ApiConfig,
      );
      const firstView = await reader.getMilestoneEvidence('1');
      const secondView = await reader.getMilestoneEvidence('2');
      expect(firstView.onChainEvidenceHash).toBe(replacement);
      expect(firstView.documents).toHaveLength(0);
      expect(secondView.onChainEvidenceHash).toBe(digest);
      expect(secondView.documents[0]?.anchoredOnChain).toBe(true);
    });

    it('projects settlement with the funder repaid first', async () => {
      await setUpSubmitted();
      await seedActivePosition();
      await apply('milestone_verified', {
        milestone_id: 1n,
        attestor: ADDRESSES.attestor,
        evidence_hash: digest,
      });
      await apply('milestone_settled', {
        order_id: 1n,
        milestone_id: 1n,
        protected_amount: 10_000_0000000n,
        funder_repayment: 7_350_0000000n,
        supplier_payout: 2_650_0000000n,
      });

      const settlement = await prisma.settlementReadModel.findFirstOrThrow();
      expect(settlement.protectedAmount.toFixed(0)).toBe('100000000000');
      expect(
        BigInt(settlement.funderRepayment.toFixed(0)) +
          BigInt(settlement.supplierPayout.toFixed(0)),
      ).toBe(BigInt(settlement.protectedAmount.toFixed(0)));
      const settled = await prisma.milestoneReadModel.findFirstOrThrow();
      expect(settled.status).toBe('SETTLED');
      // The escrow is empty: the contract released all of it. Saying otherwise
      // tells the buyer their money is still held by the contract.
      expect(settled.fundedAmount.toFixed(0)).toBe('0');
      // What was protected survives on the settlement row, not the milestone.
      expect(settlement.protectedAmount.toFixed(0)).toBe('100000000000');
      expect((await prisma.financePositionReadModel.findFirstOrThrow()).status).toBe('REPAID');
    });

    it('projects a refund without clawing back the funder advance', async () => {
      await setUpSubmitted();
      await seedActivePosition();
      await apply('milestone_refunded', {
        order_id: 1n,
        milestone_id: 1n,
        buyer: ADDRESSES.buyer,
        refunded_amount: 10_000_0000000n,
        funder_advance_outstanding: 7_000_0000000n,
      });

      const refund = await prisma.refundReadModel.findFirstOrThrow();
      // The supplier keeps the advance; the funder's claim is off-chain.
      expect(refund.funderAdvanceOutstanding.toFixed(0)).toBe('70000000000');
      const refunded = await prisma.milestoneReadModel.findFirstOrThrow();
      expect(refunded.status).toBe('REFUNDED');
      // Everything the milestone held went back to the buyer.
      expect(refunded.fundedAmount.toFixed(0)).toBe('0');
      expect(refund.refundedAmount.toFixed(0)).toBe('100000000000');
      expect((await prisma.financePositionReadModel.findFirstOrThrow()).status).toBe('CLOSED');
    });

    it('projects an unfinanced refund with no position to close', async () => {
      await setUpSubmitted();
      await apply('milestone_refunded', {
        order_id: 1n,
        milestone_id: 1n,
        buyer: ADDRESSES.buyer,
        refunded_amount: 10_000_0000000n,
        funder_advance_outstanding: 0n,
      });

      expect((await prisma.milestoneReadModel.findFirstOrThrow()).status).toBe('REFUNDED');
      expect(await prisma.financePositionReadModel.count()).toBe(0);
    });

    it('fails closed when a financed refund finds no active position to close', async () => {
      await setUpSubmitted();

      // The chain reports an outstanding advance, which it only does when it
      // closed an ACTIVE position. A read model without one has diverged.
      await expect(
        apply('milestone_refunded', {
          order_id: 1n,
          milestone_id: 1n,
          buyer: ADDRESSES.buyer,
          refunded_amount: 10_000_0000000n,
          funder_advance_outstanding: 7_000_0000000n,
        }),
      ).rejects.toThrow(/chain implies 1/);
    });

    it('fails closed when an unfinanced refund finds a live position', async () => {
      await setUpSubmitted();
      await seedActivePosition();

      // Outstanding 0 means the chain closed no position; one still being live
      // here would be silently closed by a naive projection.
      await expect(
        apply('milestone_refunded', {
          order_id: 1n,
          milestone_id: 1n,
          buyer: ADDRESSES.buyer,
          refunded_amount: 10_000_0000000n,
          funder_advance_outstanding: 0n,
        }),
      ).rejects.toThrow(/chain implies 0/);
    });

    it('projects a dispute and its resolution', async () => {
      await setUpSubmitted();
      await apply('dispute_opened', {
        milestone_id: 1n,
        dispute_id: 1n,
        opened_by: ADDRESSES.buyer,
        resolver: ADDRESSES.resolver,
      });
      expect((await prisma.milestoneReadModel.findFirstOrThrow()).status).toBe('DISPUTED');

      await apply('dispute_resolved', {
        milestone_id: 1n,
        dispute_id: 1n,
        resolver: ADDRESSES.resolver,
        settled: true,
      });
      expect((await prisma.disputeReadModel.findFirstOrThrow()).status).toBe('RESOLVED_SETTLE');
      // A resolution decides; it does not pay. The payout is its own event.
      expect((await prisma.milestoneReadModel.findFirstOrThrow()).status).toBe('VERIFIED');
      expect(await prisma.settlementReadModel.count()).toBe(0);
    });
  });

  describe('events the chain did not adopt', () => {
    it('ignores events from a reverted contract call', async () => {
      const { projected } = await apply(
        'order_created',
        {
          order_id: 1n,
          buyer: ADDRESSES.buyer,
          supplier: ADDRESSES.supplier,
          attestor: ADDRESSES.attestor,
          resolver: ADDRESSES.resolver,
          asset: ADDRESSES.usdcSac,
        },
        { successful: false },
      );

      expect(projected).toBe(false);
      expect(await prisma.orderReadModel.count()).toBe(0);
    });
  });

  describe('out-of-order delivery', () => {
    it('does not roll a row backwards when an older event is redelivered', async () => {
      await createOrder();
      const accepted = decodeEvent(
        rawEvent('order_accepted', { order_id: 1n, supplier: ADDRESSES.supplier }),
      );
      const completed = decodeEvent(rawEvent('order_completed', { order_id: 1n }));

      await projectEvent(prisma, CTX, accepted);
      await projectEvent(prisma, CTX, completed);
      // The older event arrives again after the newer one.
      await projectEvent(prisma, CTX, accepted);

      expect((await prisma.orderReadModel.findFirstOrThrow()).status).toBe('COMPLETED');
    });
  });
});

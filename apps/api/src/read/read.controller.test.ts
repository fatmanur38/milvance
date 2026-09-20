import { BadRequestException } from '@nestjs/common';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { ApiConfig } from '../config';
import type { PrismaClient } from '../generated/prisma/client';
import { decodeEvent } from '../indexer/decoder';
import {
  ADDRESSES,
  CONTRACT_ID,
  NETWORK,
  rawEvent,
  resetFixtureSequence,
} from '../indexer/fixtures.test-helper';
import { projectEvent } from '../indexer/projector';
import { hasTestDatabase, testClient, truncateAll } from '../indexer/test-db.test-helper';
import type { PrismaService } from '../prisma/prisma.service';
import { ReadController } from './read.controller';
import type { ReconcileService } from './reconcile.service';

/**
 * Wallet-scoped reads, against a real database seeded through the real
 * projector — so these queries see exactly the rows the indexer would write.
 */
const suite = hasTestDatabase ? describe : describe.skip;

const CTX = { network: NETWORK, contractId: CONTRACT_ID };
const OUTSIDER = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

suite('wallet-scoped reads', () => {
  const prisma: PrismaClient = hasTestDatabase
    ? testClient()
    : (undefined as unknown as PrismaClient);
  const controller = new ReadController(
    prisma as unknown as PrismaService,
    {} as ReconcileService,
    { stellar: { network: NETWORK, contractId: CONTRACT_ID } } as ApiConfig,
  );

  const apply = (name: string, fields: Record<string, unknown>) =>
    projectEvent(prisma, CTX, decodeEvent(rawEvent(name, fields)));

  beforeEach(async () => {
    resetFixtureSequence();
    await truncateAll(prisma);
    await apply('order_created', {
      order_id: 1n,
      buyer: ADDRESSES.buyer,
      supplier: ADDRESSES.supplier,
      attestor: ADDRESSES.attestor,
      resolver: ADDRESSES.resolver,
      asset: ADDRESSES.usdcSac,
    });
    await apply('milestone_created', {
      order_id: 1n,
      milestone_id: 1n,
      index: 0,
      amount: 10_000_0000000n,
      deadline: null,
    });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it.each([
    ['buyer', ADDRESSES.buyer],
    ['supplier', ADDRESSES.supplier],
    ['attestor', ADDRESSES.attestor],
    ['resolver', ADDRESSES.resolver],
  ])('finds the order for its %s', async (_role, wallet) => {
    const result = await controller.listOrders(undefined, undefined, wallet);
    expect(result.count).toBe(1);
    expect(result.orders[0]?.orderId).toBe('1');
    // Milestones travel with the list so a workspace needs no N+1 requests.
    expect(result.orders[0]?.milestones.map((m) => m.amount)).toEqual(['100000000000']);
  });

  it('finds nothing for a wallet with no role on any order', async () => {
    const result = await controller.listOrders(undefined, undefined, OUTSIDER);
    expect(result.count).toBe(0);
  });

  it('matches addresses exactly, never case-insensitively', async () => {
    await expect(
      controller.listOrders(undefined, undefined, ADDRESSES.buyer.toLowerCase()),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("lists a funder's offers, including accepted ones no longer open", async () => {
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

    // The request is no longer open, so it has left the opportunities list...
    expect((await controller.fundingOpportunities()).opportunities).toHaveLength(0);
    // ...but the funder can still find the accepted offer they must now fund.
    const { offers } = await controller.fundingOffers(ADDRESSES.funder);
    expect(offers).toHaveLength(1);
    expect(offers[0]?.status).toBe('ACCEPTED');
    expect(offers[0]?.order.supplier).toBe(ADDRESSES.supplier);
    expect(offers[0]?.request?.status).toBe('ACCEPTED');
  });

  it('carries order parties on an open opportunity', async () => {
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

    const { opportunities } = await controller.fundingOpportunities();
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0]?.order.buyer).toBe(ADDRESSES.buyer);
    expect(opportunities[0]?.protectedAmount).toBe('100000000000');
  });

  it('requires a valid funder address', async () => {
    await expect(controller.fundingOffers(undefined)).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.fundingOffers('not-an-address')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

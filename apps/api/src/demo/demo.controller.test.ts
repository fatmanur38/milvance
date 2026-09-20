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
import { DemoController } from './demo.controller';

/**
 * Participation consent: the only thing Trade Lab writes to the database.
 *
 * These tests pin two properties. It stores consent and nothing that could
 * identify a person, and it cannot touch financial state — a demo helper that
 * could nudge a chain projection would make every number in the product
 * suspect.
 */
const suite = hasTestDatabase ? describe : describe.skip;

const OUTSIDER = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

suite('demo participation consent', () => {
  const prisma: PrismaClient = hasTestDatabase
    ? testClient()
    : (undefined as unknown as PrismaClient);
  const controller = new DemoController(
    prisma as unknown as PrismaService,
    {
      stellar: { network: NETWORK, contractId: CONTRACT_ID },
    } as ApiConfig,
  );

  beforeEach(async () => {
    resetFixtureSequence();
    await truncateAll(prisma);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('records consent for a wallet, and reads it back', async () => {
    const saved = await controller.record({
      walletAddress: OUTSIDER,
      consentToCount: true,
    });
    expect(saved.consentToCount).toBe(true);
    expect(saved.isTeam).toBe(false);

    const read = await controller.show(OUTSIDER);
    expect(read).toMatchObject({ walletAddress: OUTSIDER, known: true, consentToCount: true });
  });

  it('lets someone withdraw consent', async () => {
    await controller.record({ walletAddress: OUTSIDER, consentToCount: true });
    await controller.record({ walletAddress: OUTSIDER, consentToCount: false });
    expect((await controller.show(OUTSIDER)).consentToCount).toBe(false);
    expect(await prisma.demoParticipant.count()).toBe(1);
  });

  it('reports an unknown wallet as simply not counted', async () => {
    const read = await controller.show(OUTSIDER);
    expect(read).toEqual({
      walletAddress: OUTSIDER,
      known: false,
      consentToCount: false,
      isTeam: false,
    });
  });

  it('never lets a browser clear the team flag', async () => {
    // One-way by design: self-declaring as team only ever removes a wallet
    // from external counts, and nobody can promote themselves back into them.
    await controller.record({ walletAddress: OUTSIDER, consentToCount: true, isTeam: true });
    const after = await controller.record({
      walletAddress: OUTSIDER,
      consentToCount: true,
      isTeam: false,
    });
    expect(after.isTeam).toBe(true);
    expect((await controller.show(OUTSIDER)).isTeam).toBe(true);
  });

  it('compares addresses exactly, never case-folded', async () => {
    await expect(
      controller.record({ walletAddress: OUTSIDER.toLowerCase(), consentToCount: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.show(OUTSIDER.toLowerCase())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      controller.record({ walletAddress: 'nope', consentToCount: true }),
    ).rejects.toThrow(/Stellar public key/);
  });

  it('refuses anything that looks like a secret or personal detail', async () => {
    for (const field of ['jwt', 'token', 'seed', 'privateKey', 'kyc', 'iban', 'email', 'name']) {
      await expect(
        controller.record({
          walletAddress: OUTSIDER,
          consentToCount: true,
          [field]: 'x',
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(await prisma.demoParticipant.count()).toBe(0);
  });

  it('requires an explicit yes or no, and a known source', async () => {
    await expect(controller.record({ walletAddress: OUTSIDER } as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      controller.record({ walletAddress: OUTSIDER, consentToCount: true, source: 'wherever' }),
    ).rejects.toThrow(/source must be one of/);
  });

  it('cannot touch a single financial row', async () => {
    // Seed real chain projections through the real projector, then let the demo
    // endpoint do its worst.
    await projectEvent(
      prisma,
      { network: NETWORK, contractId: CONTRACT_ID },
      decodeEvent(
        rawEvent('order_created', {
          order_id: 1n,
          buyer: ADDRESSES.buyer,
          supplier: ADDRESSES.supplier,
          attestor: ADDRESSES.attestor,
          resolver: ADDRESSES.resolver,
          asset: ADDRESSES.usdcSac,
        }),
      ),
    );
    const before = await snapshot(prisma);

    await controller.record({ walletAddress: ADDRESSES.buyer, consentToCount: true });
    await controller.record({ walletAddress: OUTSIDER, consentToCount: true, isTeam: true });

    expect(await snapshot(prisma)).toEqual(before);
    expect(await prisma.demoParticipant.count()).toBe(2);
  });
});

/** Everything chain-derived, as a comparable fingerprint. */
async function snapshot(prisma: PrismaClient) {
  const [orders, milestones, offers, positions, settlements, refunds, events] = await Promise.all([
    prisma.orderReadModel.findMany({ orderBy: { orderId: 'asc' } }),
    prisma.milestoneReadModel.findMany({ orderBy: { milestoneId: 'asc' } }),
    prisma.fundingOfferReadModel.findMany(),
    prisma.financePositionReadModel.findMany(),
    prisma.settlementReadModel.findMany(),
    prisma.refundReadModel.findMany(),
    prisma.indexedContractEvent.findMany({ orderBy: { eventId: 'asc' } }),
  ]);
  return JSON.parse(
    JSON.stringify(
      { orders, milestones, offers, positions, settlements, refunds, events },
      (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
    ),
  ) as unknown;
}

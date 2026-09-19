import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';

import type { ApiConfig } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { API_CONFIG } from '../tokens';
import { ReconcileService } from './reconcile.service';
import {
  serialiseDispute,
  serialiseFinanceRequest,
  serialiseMilestone,
  serialiseOffer,
  serialiseOrder,
  serialisePosition,
} from './serialise';

/**
 * Read-only projections of chain state.
 *
 * EVERY route here is a `@Get`. That is not an oversight to be corrected later:
 * financial state changes by a user-signed Soroban transaction and by nothing
 * else, so a `PATCH /milestones/:id { status: 'SETTLED' }` must not exist to be
 * called. `chain-write-surface.test.ts` asserts this by reflection, so adding a
 * mutating route to this controller fails the build.
 */

function parseChainId(raw: string, label: string): bigint {
  if (!/^\d+$/.test(raw)) {
    throw new BadRequestException(`${label} must be a whole number`);
  }
  const value = BigInt(raw);
  if (value <= 0n) {
    // Contract counters start at 1, so 0 is never a real id.
    throw new BadRequestException(`${label} must be greater than zero`);
  }
  return value;
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) {
    return 50;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    throw new BadRequestException('limit must be an integer between 1 and 200');
  }
  return value;
}

@Controller()
export class ReadController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reconcile: ReconcileService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  private get scope() {
    return {
      network: this.config.stellar.network,
      contractId: this.config.stellar.contractId,
    };
  }

  @Get('orders')
  async listOrders(
    @Query('buyer') buyer?: string,
    @Query('supplier') supplier?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    const rows = await this.prisma.orderReadModel.findMany({
      where: {
        ...this.scope,
        ...(buyer !== undefined ? { buyer } : {}),
        ...(supplier !== undefined ? { supplier } : {}),
        ...(status !== undefined ? { status: status.toUpperCase() as never } : {}),
      },
      orderBy: { orderId: 'asc' },
      take: parseLimit(limit),
    });
    return { orders: rows.map(serialiseOrder), count: rows.length };
  }

  @Get('orders/:orderId')
  async getOrder(@Param('orderId') orderId: string) {
    const id = parseChainId(orderId, 'orderId');
    const row = await this.prisma.orderReadModel.findUnique({
      where: { order_identity: { ...this.scope, orderId: id } },
      include: { milestones: { orderBy: { index: 'asc' } } },
    });
    if (row === null) {
      throw new NotFoundException(`Order ${orderId} is not in the read model`);
    }
    return {
      ...serialiseOrder(row),
      milestones: row.milestones.map((milestone) => serialiseMilestone(milestone)),
    };
  }

  @Get('orders/:orderId/milestones')
  async listOrderMilestones(@Param('orderId') orderId: string) {
    const id = parseChainId(orderId, 'orderId');
    const rows = await this.prisma.milestoneReadModel.findMany({
      where: { ...this.scope, orderId: id },
      orderBy: { index: 'asc' },
    });
    return { orderId, milestones: rows.map((row) => serialiseMilestone(row)) };
  }

  @Get('milestones/:milestoneId')
  async getMilestone(@Param('milestoneId') milestoneId: string) {
    const id = parseChainId(milestoneId, 'milestoneId');
    const row = await this.prisma.milestoneReadModel.findUnique({
      where: { milestone_identity: { ...this.scope, milestoneId: id } },
    });
    if (row === null) {
      throw new NotFoundException(`Milestone ${milestoneId} is not in the read model`);
    }
    return serialiseMilestone(row);
  }

  /**
   * Financing view for one milestone.
   *
   * Presents the two money pools side by side and labelled, because conflating
   * them is the single most damaging misreading of this product: `protected` is
   * the buyer's escrow, `advance` is the funder's own capital.
   */
  @Get('milestones/:milestoneId/finance')
  async getMilestoneFinance(@Param('milestoneId') milestoneId: string) {
    const id = parseChainId(milestoneId, 'milestoneId');
    const milestone = await this.prisma.milestoneReadModel.findUnique({
      where: { milestone_identity: { ...this.scope, milestoneId: id } },
      include: {
        financeRequest: true,
        fundingOffers: { orderBy: { offerId: 'asc' } },
        financePosition: { orderBy: { offerId: 'asc' } },
      },
    });
    if (milestone === null) {
      throw new NotFoundException(`Milestone ${milestoneId} is not in the read model`);
    }
    const active = milestone.financePosition.find((position) => position.status === 'ACTIVE');
    return {
      milestoneId,
      buyerProtectedEscrow: milestone.fundedAmount.toFixed(0),
      funderAdvance: active?.principal.toFixed(0) ?? '0',
      request:
        milestone.financeRequest === null
          ? null
          : serialiseFinanceRequest(milestone.financeRequest),
      offers: milestone.fundingOffers.map(serialiseOffer),
      positions: milestone.financePosition.map(serialisePosition),
    };
  }

  @Get('milestones/:milestoneId/evidence')
  async getMilestoneEvidence(@Param('milestoneId') milestoneId: string) {
    const id = parseChainId(milestoneId, 'milestoneId');
    const anchors = await this.prisma.evidenceAnchorReadModel.findMany({
      where: { ...this.scope, milestoneId: id },
    });
    const byHash = new Map(anchors.map((anchor) => [anchor.contentHash, anchor]));
    const objects = await this.prisma.evidenceObject.findMany({
      where: {
        ...this.scope,
        OR: [{ milestoneId: id }, { contentHash: { in: [...byHash.keys()] } }],
      },
      orderBy: { createdAt: 'asc' },
    });
    const milestone = await this.prisma.milestoneReadModel.findUnique({
      where: { milestone_identity: { ...this.scope, milestoneId: id } },
    });
    return {
      milestoneId,
      /** The commitment the contract holds. */
      onChainEvidenceHash: milestone?.evidenceHash ?? null,
      documents: objects.map((object) => ({
        contentHash: object.contentHash,
        filename: object.filename,
        mimeType: object.mimeType,
        byteSize: object.byteSize.toString(),
        documentLabel: object.documentLabel,
        uploadedBy: object.uploadedBy,
        anchoredOnChain: byHash.has(object.contentHash),
        anchoredTxHash: byHash.get(object.contentHash)?.submittedTxHash ?? null,
        createdAt: object.createdAt.toISOString(),
      })),
    };
  }

  @Get('milestones/:milestoneId/disputes')
  async getMilestoneDisputes(@Param('milestoneId') milestoneId: string) {
    const id = parseChainId(milestoneId, 'milestoneId');
    const rows = await this.prisma.disputeReadModel.findMany({
      where: { ...this.scope, milestoneId: id },
      orderBy: { disputeId: 'asc' },
    });
    return { milestoneId, disputes: rows.map(serialiseDispute) };
  }

  /** Funding opportunities: milestones actively seeking capital (AGENT.md §30). */
  @Get('funding/opportunities')
  async fundingOpportunities(@Query('limit') limit?: string) {
    const rows = await this.prisma.financeRequestReadModel.findMany({
      where: { ...this.scope, status: 'OPEN' },
      include: { milestone: true },
      orderBy: { createdAt: 'desc' },
      take: parseLimit(limit),
    });
    return {
      opportunities: rows.map((row) => ({
        ...serialiseFinanceRequest(row),
        milestone: serialiseMilestone(row.milestone),
      })),
    };
  }

  @Get('funding/positions')
  async fundingPositions(@Query('funder') funder?: string, @Query('limit') limit?: string) {
    const rows = await this.prisma.financePositionReadModel.findMany({
      where: { ...this.scope, ...(funder !== undefined ? { funder } : {}) },
      orderBy: { fundedAt: 'desc' },
      take: parseLimit(limit),
    });
    return { positions: rows.map(serialisePosition) };
  }

  /** Chain-ordered activity feed built from the raw event log. */
  @Get('activity')
  async activity(@Query('limit') limit?: string) {
    const rows = await this.prisma.indexedContractEvent.findMany({
      where: { ...this.scope, successful: true },
      orderBy: { eventId: 'desc' },
      take: parseLimit(limit),
    });
    return {
      activity: rows.map((row) => ({
        eventId: row.eventId,
        eventName: row.eventName,
        ledger: row.ledger.toString(),
        txHash: row.txHash,
        ledgerClosedAt: row.ledgerClosedAt.toISOString(),
        projected: row.projected,
        fields: row.payload,
      })),
    };
  }

  /**
   * Compare a projection against authoritative contract state.
   *
   * Read-only on both sides. A mismatch is reported, never repaired here.
   */
  @Get('reconcile/orders/:orderId')
  async reconcileOrder(@Param('orderId') orderId: string) {
    return this.reconcile.reconcileOrder(parseChainId(orderId, 'orderId'));
  }

  @Get('reconcile/milestones/:milestoneId')
  async reconcileMilestone(@Param('milestoneId') milestoneId: string) {
    return this.reconcile.reconcileMilestone(parseChainId(milestoneId, 'milestoneId'));
  }
}

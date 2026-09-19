import { Controller, Get, Inject } from '@nestjs/common';

import type { ApiConfig } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { API_CONFIG } from '../tokens';

/** Public counters grounded in indexed Testnet events. Local-payment cycles
 * require separate verification; self-reported Anchor metadata never counts. */
@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get('public')
  async publicMetrics() {
    const scope = {
      network: this.config.stellar.network,
      contractId: this.config.stellar.contractId,
    };
    const [totals, completedLocalPaymentCycles, cursor] = await Promise.all([
      this.prisma.analyticsDaily.aggregate({
        where: scope,
        _sum: {
          ordersCreated: true,
          milestonesFunded: true,
          advancesFunded: true,
          milestonesSettled: true,
          milestonesRefunded: true,
          disputesOpened: true,
        },
      }),
      this.prisma.localPaymentCycleReadModel.count({ where: { ...scope, status: 'VERIFIED' } }),
      this.prisma.indexerCursor.findUnique({ where: { cursor_stream: scope } }),
    ]);
    const sum = totals._sum;
    return {
      source: 'indexed-soroban-events',
      network: scope.network,
      contractId: scope.contractId,
      throughLedger: cursor?.scannedThroughLedger?.toString() ?? null,
      ordersCreated: sum.ordersCreated ?? 0,
      milestonesFunded: sum.milestonesFunded ?? 0,
      advancesFunded: sum.advancesFunded ?? 0,
      milestonesSettled: sum.milestonesSettled ?? 0,
      milestonesRefunded: sum.milestonesRefunded ?? 0,
      disputesOpened: sum.disputesOpened ?? 0,
      completedLocalPaymentCycles,
      note: 'Local-payment cycles count only independently verified links; submitted Anchor metadata alone is not proof.',
    };
  }
}

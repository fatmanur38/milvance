import { Controller, Get, Inject } from '@nestjs/common';

import type { ApiConfig } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { API_CONFIG } from '../tokens';
import {
  ADOPTION_METRICS,
  ALL_DEFINITIONS,
  LOCAL_PAYMENT_METRICS,
  NORTH_STAR,
  NOT_DERIVABLE,
  PROTOCOL_METRICS,
  TIMING_METRICS,
  USDC_DECIMALS,
} from './definitions';
import { computePublicMetrics } from './public-metrics';

/**
 * The public traction surface (AGENT.md §29, §30, PKG-11).
 *
 * Read-only, and deliberately boring: it computes from indexed chain state and
 * admitted reports, and there is no way to write a number into it. There is no
 * counter to increment, no override parameter, and no request body — a caller
 * cannot tell this endpoint that adoption is higher than it is.
 *
 * It serves the definitions next to the values on purpose. A number whose
 * meaning is only in our heads is not evidence, and a judge should be able to
 * disagree with a definition without reading TypeScript to find it.
 */
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
    const [metrics, cursor, events] = await Promise.all([
      computePublicMetrics(this.prisma, scope),
      this.prisma.indexerCursor.findUnique({ where: { cursor_stream: scope } }),
      this.prisma.indexedContractEvent.count({ where: scope }),
    ]);

    return {
      scope: {
        network: scope.network,
        contractId: scope.contractId,
        testnetOnly: scope.network !== 'public',
        usdcDecimals: USDC_DECIMALS,
        note: 'Milvance runs on Stellar Testnet with test USDC. Every figure below is testnet activity.',
      },
      provenance: {
        chainMetrics: 'Projected from MilvanceCore events; rebuildable from Stellar at any time.',
        localPaymentMetrics:
          'Reported by the Anchor flow. The Stellar side of each report is checked against Horizon; the fiat side cannot be proven by any blockchain.',
        adoptionMetrics:
          'Wallet owners classify themselves. External participation is opt-in and is never inferred from activity.',
        indexedThroughLedger: cursor?.scannedThroughLedger?.toString() ?? null,
        indexedEvents: events,
      },
      ...metrics,
      definitions: {
        protocolActivity: PROTOCOL_METRICS,
        localPayments: LOCAL_PAYMENT_METRICS,
        northStar: NORTH_STAR,
        adoption: ADOPTION_METRICS,
        timings: TIMING_METRICS,
        notDerivable: NOT_DERIVABLE,
        count: ALL_DEFINITIONS.length,
      },
    };
  }
}

import { Module } from '@nestjs/common';

import { loadConfig, type ApiConfig } from './config';
import { DemoController } from './demo/demo.controller';
import { createEvidenceStorage, type EvidenceStorage } from './evidence/storage';
import { EvidenceController } from './evidence/evidence.controller';
import { HealthController } from './health/health.controller';
import { IndexerService } from './indexer/indexer.service';
import { LocalPaymentsController } from './local-payments/local-payments.controller';
import { MetricsController } from './metrics/metrics.controller';
import { PrismaService } from './prisma/prisma.service';
import { ReadController } from './read/read.controller';
import { ReconcileService } from './read/reconcile.service';
import { API_CONFIG, EVIDENCE_STORAGE } from './tokens';

/**
 * Root application module.
 *
 * The standing constraint from AGENT.md §13 and §23, restated because it is the
 * reason this module looks the way it does: this backend is a read model and
 * orchestration layer. It never becomes the financial source of truth, never
 * holds a user secret key, and never signs a user's financial transaction.
 *
 * There is consequently no signer, no keystore and no wallet provider wired in
 * below — not as a deferred TODO, but because the architecture forbids one.
 */
@Module({
  controllers: [
    ReadController,
    HealthController,
    EvidenceController,
    LocalPaymentsController,
    MetricsController,
    DemoController,
  ],
  providers: [
    { provide: API_CONFIG, useFactory: (): ApiConfig => loadConfig() },
    {
      provide: PrismaService,
      useFactory: (config: ApiConfig) => new PrismaService(config.databaseUrl),
      inject: [API_CONFIG],
    },
    {
      provide: IndexerService,
      useFactory: (prisma: PrismaService, config: ApiConfig) => new IndexerService(prisma, config),
      inject: [PrismaService, API_CONFIG],
    },
    {
      provide: ReconcileService,
      useFactory: (prisma: PrismaService, config: ApiConfig) =>
        new ReconcileService(prisma, config),
      inject: [PrismaService, API_CONFIG],
    },
    {
      provide: EVIDENCE_STORAGE,
      useFactory: (config: ApiConfig): EvidenceStorage => createEvidenceStorage(config.evidence),
      inject: [API_CONFIG],
    },
  ],
})
export class AppModule {}

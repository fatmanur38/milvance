import { Module } from '@nestjs/common';

/**
 * Root application module.
 *
 * PKG-00 scope: an empty, bootable Nest application.
 *
 * Controllers, Prisma, PostgreSQL read models, the Soroban indexer and the Anchor
 * orchestration endpoints are introduced in PKG-07 / PKG-08.
 *
 * Standing constraint (AGENT.md §13, §23): this backend is a read model and
 * orchestration layer. It must never become the financial source of truth, hold
 * user secret keys, or sign a user's financial transaction.
 */
@Module({
  imports: [],
  controllers: [],
  providers: [],
})
export class AppModule {}

import { Controller, Get, Inject } from '@nestjs/common';

import type { ApiConfig } from '../config';
import { IndexerService } from '../indexer/indexer.service';
import { PrismaService } from '../prisma/prisma.service';
import { API_CONFIG } from '../tokens';

/**
 * Health and readiness.
 *
 * A live process is not a healthy system. These checks report the three things
 * that can independently fail — the database, the Stellar RPC and the indexer's
 * progress — and a degraded indexer is reported as degraded even though HTTP is
 * perfectly happy to keep serving stale projections.
 *
 * Nothing here leaks a connection string, a host credential or a token.
 */

type Check = { status: 'ok' | 'degraded' | 'down'; detail?: string };

/** Ledgers behind chain head before the indexer is considered degraded. */
const LAG_THRESHOLD_LEDGERS = 120n;

@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly indexer: IndexerService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  /** Liveness: is this process up at all? */
  @Get('health')
  health() {
    return {
      status: 'ok',
      service: 'milvance-api',
      network: this.config.stellar.network,
      contractId: this.config.stellar.contractId,
      /** Stated in every health payload so nobody mistakes this for the ledger. */
      role: 'derived read model and metadata store; Soroban is the financial source of truth',
      time: new Date().toISOString(),
    };
  }

  /** Readiness: is it actually able to serve trustworthy reads? */
  @Get('health/ready')
  async ready() {
    const database = await this.checkDatabase();
    const { rpc, head } = await this.checkRpc();
    const indexer = await this.checkIndexer(head);

    const checks = { database, rpc, indexer };
    const status = Object.values(checks).some((check) => check.status === 'down')
      ? 'down'
      : Object.values(checks).some((check) => check.status === 'degraded')
        ? 'degraded'
        : 'ok';

    return { status, checks, time: new Date().toISOString() };
  }

  @Get('indexer/status')
  async indexerStatus() {
    const status = await this.indexer.status();
    let chainHead: string | null = null;
    let lag: string | null = null;
    try {
      const head = await this.indexer.chainHead();
      chainHead = head.toString();
      if (status.scannedThroughLedger !== null) {
        const behind = head - BigInt(status.scannedThroughLedger);
        lag = (behind > 0n ? behind : 0n).toString();
      }
    } catch {
      // Reported through `health/ready`; the cursor state is still useful here.
    }
    return { ...status, chainHead, ledgersBehind: lag };
  }

  private async checkDatabase(): Promise<Check> {
    try {
      await this.prisma.ping();
      return { status: 'ok' };
    } catch {
      // Deliberately not echoing the driver error: it can contain the DSN.
      return { status: 'down', detail: 'PostgreSQL is not reachable' };
    }
  }

  private async checkRpc(): Promise<{ rpc: Check; head: bigint | null }> {
    try {
      const head = await this.indexer.chainHead();
      return { rpc: { status: 'ok', detail: `ledger ${head.toString()}` }, head };
    } catch {
      return { rpc: { status: 'down', detail: 'Stellar RPC is not reachable' }, head: null };
    }
  }

  private async checkIndexer(head: bigint | null): Promise<Check> {
    let status;
    try {
      status = await this.indexer.status();
    } catch {
      return { status: 'down', detail: 'indexer state is unreadable' };
    }

    if (status.lastError !== null) {
      return { status: 'degraded', detail: status.lastError };
    }
    if (status.unprojectedSuccessfulEvents > 0) {
      return {
        status: 'degraded',
        detail: `${status.unprojectedSuccessfulEvents} successful event(s) need projection support`,
      };
    }
    if (status.scannedThroughLedger === null) {
      return { status: 'degraded', detail: 'indexer has not completed a pass yet' };
    }
    if (head !== null) {
      const behind = head - BigInt(status.scannedThroughLedger);
      if (behind > LAG_THRESHOLD_LEDGERS) {
        return { status: 'degraded', detail: `${behind.toString()} ledgers behind chain head` };
      }
    }
    return { status: 'ok', detail: `scanned through ledger ${status.scannedThroughLedger}` };
  }
}

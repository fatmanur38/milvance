import { Injectable, Logger } from '@nestjs/common';

import type { Prisma } from '../generated/prisma/client';
import type { ApiConfig } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { compareEventOrder, fieldsToJson, type DecodedEvent } from './decoder';
import { eventLogRow, projectEvent, type ProjectionContext } from './projector';
import { LedgerOutOfRangeError, SorobanRpc } from './rpc';
import { dailyMetric } from '../metrics/daily';

class StaleIndexerCursorError extends Error {
  constructor() {
    super('Indexer cursor changed while a page was being fetched');
  }
}

/**
 * The Soroban event indexer.
 *
 * Guarantees, in the order they matter:
 *
 *   ATOMIC        — one database transaction per batch holds the raw event
 *                   rows, every projection they imply, and the cursor advance.
 *   SAFE ON FAILURE — if any event in a batch fails, the transaction rolls back
 *                   and the cursor still points before that event. The indexer
 *                   never steps over something it could not store.
 *   IDEMPOTENT    — duplicate ingestion is impossible: two unique constraints on
 *                   event identity, plus per-row monotonic `lastEventId` guards.
 *   RESTARTABLE   — the cursor is the RPC's own paging token, so a restart
 *                   resumes exactly where it stopped.
 *   REPLAYABLE    — `reset()` drops derived rows and rewinds the cursor. Chain
 *                   state is never touched; rebuilding is a local operation.
 *   OBSERVABLE    — structured logs and a status endpoint, carrying no secrets.
 *
 * What it deliberately does NOT do: decide anything. It has no rule that can
 * settle, refund, expire or advance a milestone. Every financial value it writes
 * came from an event the contract emitted.
 */

export interface IndexerRunResult {
  readonly pagesFetched: number;
  readonly eventsIngested: number;
  readonly eventsProjected: number;
  readonly duplicatesSkipped: number;
  readonly caughtUp: boolean;
  readonly latestLedger: bigint;
}

export interface IndexerStatus {
  readonly network: string;
  readonly contractId: string;
  readonly startLedger: string;
  readonly lastEventId: string | null;
  readonly lastLedger: string | null;
  readonly scannedThroughLedger: string | null;
  readonly eventsIngested: string;
  readonly unprojectedSuccessfulEvents: number;
  readonly lastPollAt: string | null;
  readonly lastEventAt: string | null;
  readonly lastErrorAt: string | null;
  readonly lastError: string | null;
  readonly running: boolean;
}

/**
 * Strip anything that could carry a credential out of an error before it is
 * stored or logged. Connection strings and URLs can embed passwords.
 */
export function redactError(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return raw
    .replace(/postgres(?:ql)?:\/\/[^\s"']*/gi, 'postgresql://[redacted]')
    .replace(/https?:\/\/[^\s"']*@/gi, 'https://[redacted]@')
    .replace(/(password|secret|token|authorization)=\S+/gi, '$1=[redacted]')
    .replace(/\bS[A-Z2-7]{55}\b/g, '[redacted-secret-key]')
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+\.?[A-Za-z0-9_-]*/g, '[redacted-jwt]')
    .slice(0, 500);
}

@Injectable()
export class IndexerService {
  private readonly logger = new Logger(IndexerService.name);
  private readonly rpc: SorobanRpc;
  private readonly ctx: ProjectionContext;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ApiConfig,
    rpc?: SorobanRpc,
  ) {
    this.rpc = rpc ?? new SorobanRpc(config.stellar.rpcUrl);
    this.ctx = { network: config.stellar.network, contractId: config.stellar.contractId };
  }

  /** Create the cursor row for this stream if it does not exist yet. */
  async ensureCursor() {
    return this.prisma.indexerCursor.upsert({
      where: { cursor_stream: this.ctx },
      create: { ...this.ctx, startLedger: this.config.indexer.startLedger },
      update: {},
    });
  }

  async status(): Promise<IndexerStatus> {
    const cursor = await this.ensureCursor();
    const unprojectedSuccessfulEvents = await this.prisma.indexedContractEvent.count({
      where: { ...this.ctx, successful: true, projected: false },
    });
    return {
      network: cursor.network,
      contractId: cursor.contractId,
      startLedger: cursor.startLedger.toString(),
      lastEventId: cursor.lastEventId,
      lastLedger: cursor.lastLedger?.toString() ?? null,
      scannedThroughLedger: cursor.scannedThroughLedger?.toString() ?? null,
      eventsIngested: cursor.eventsIngested.toString(),
      unprojectedSuccessfulEvents,
      lastPollAt: cursor.lastPollAt?.toISOString() ?? null,
      lastEventAt: cursor.lastEventAt?.toISOString() ?? null,
      lastErrorAt: cursor.lastErrorAt?.toISOString() ?? null,
      lastError: cursor.lastError,
      running: this.running,
    };
  }

  /**
   * Catch up to the chain head, one page at a time.
   *
   * Each page is its own transaction, so a long backfill that fails partway
   * keeps everything it had already committed and resumes from there.
   */
  async catchUp(maxPages = 50): Promise<IndexerRunResult> {
    if (this.running) {
      throw new Error('indexer run already in progress in this process');
    }
    this.running = true;
    let pagesFetched = 0;
    let eventsIngested = 0;
    let eventsProjected = 0;
    let duplicatesSkipped = 0;
    let latestLedger = 0n;
    let caughtUp = false;

    try {
      for (let page = 0; page < maxPages; page += 1) {
        const cursor = await this.ensureCursor();
        const query =
          cursor.lastEventId === null
            ? { contractId: this.ctx.contractId, startLedger: cursor.startLedger, limit: 100 }
            : { contractId: this.ctx.contractId, cursor: cursor.lastEventId, limit: 100 };

        // An expired resume point is a coverage failure. Never rewind to the
        // RPC's oldest available ledger: that would silently accept a gap.
        const fetched = await this.rpc.getEvents(query);

        pagesFetched += 1;
        latestLedger = fetched.latestLedger;
        const ordered = [...fetched.events].sort(compareEventOrder);

        let applied;
        try {
          applied = await this.applyBatch(
            ordered,
            fetched,
            cursor.lastEventId,
            cursor.scannedThroughLedger,
          );
        } catch (error) {
          if (error instanceof StaleIndexerCursorError) {
            // Another worker committed the page (or reset the stream) while we
            // fetched it. Read the new cursor and fetch again.
            page -= 1;
            continue;
          }
          throw error;
        }
        eventsIngested += applied.ingested;
        eventsProjected += applied.projected;
        duplicatesSkipped += applied.duplicates;

        if (ordered.length === 0) {
          caughtUp = true;
          break;
        }
      }
      return {
        pagesFetched,
        eventsIngested,
        eventsProjected,
        duplicatesSkipped,
        caughtUp,
        latestLedger,
      };
    } catch (error) {
      const message =
        error instanceof LedgerOutOfRangeError
          ? 'Indexer history is outside RPC retention; restore an archival event source before resuming'
          : redactError(error);
      await this.recordError(message);
      throw error;
    } finally {
      this.running = false;
    }
  }

  /**
   * Persist one page: raw rows, projections and the cursor, all or nothing.
   */
  private async applyBatch(
    events: DecodedEvent[],
    page: { cursor: string | undefined; scannedThroughLedger: bigint },
    expectedEventId: string | null,
    expectedScannedLedger: bigint | null,
  ): Promise<{ ingested: number; projected: number; duplicates: number }> {
    let ingested = 0;
    let projected = 0;
    let duplicates = 0;

    await this.prisma.$transaction(async (tx) => {
      // The cursor row is the per-stream mutex. A second process waits here,
      // then sees the changed checkpoint and refetches instead of projecting
      // against stale state or moving the cursor backwards.
      const locked = await tx.$queryRaw<
        Array<{ lastEventId: string | null; scannedThroughLedger: bigint | null }>
      >`
        SELECT "lastEventId", "scannedThroughLedger" FROM "IndexerCursor"
        WHERE "network" = ${this.ctx.network} AND "contractId" = ${this.ctx.contractId}
        FOR UPDATE
      `;
      const current = locked[0];
      if (
        current === undefined ||
        current.lastEventId !== expectedEventId ||
        current.scannedThroughLedger !== expectedScannedLedger
      ) {
        throw new StaleIndexerCursorError();
      }

      // Duplicates are filtered by a SELECT rather than by catching the unique
      // violation. PostgreSQL aborts an entire transaction on a constraint
      // failure, so a caught-and-ignored P2002 would poison every later
      // statement in this batch — the unique indexes stay as the last line of
      // defence against a concurrent writer, but they are not the mechanism
      // ordinary replay relies on.
      const incomingIds = events.map((event) => event.eventId);
      const alreadyStored = await tx.indexedContractEvent.findMany({
        where: { ...this.ctx, eventId: { in: incomingIds } },
        select: { eventId: true },
      });
      const seen = new Set(alreadyStored.map((row) => row.eventId));

      for (const event of events) {
        if (event.contractId !== this.ctx.contractId) {
          // The RPC filter should make this impossible; refuse rather than
          // project another contract's state into our read model.
          throw new Error(`event ${event.eventId} is from contract ${event.contractId}`);
        }

        if (seen.has(event.eventId)) {
          duplicates += 1;
          continue;
        }
        seen.add(event.eventId);

        const payload = fieldsToJson(event.fields) as Prisma.InputJsonObject;
        const didProject = await projectEvent(tx, this.ctx, event);
        await tx.indexedContractEvent.create({
          data: eventLogRow(this.ctx, event, payload, didProject),
        });
        if (didProject && event.successful) {
          const counts = dailyMetric(event);
          if (Object.values(counts).some((count) => count > 0)) {
            const day = new Date(
              `${event.ledgerClosedAt.toISOString().slice(0, 10)}T00:00:00.000Z`,
            );
            await tx.analyticsDaily.upsert({
              where: { daily_identity: { ...this.ctx, day } },
              create: { ...this.ctx, day, ...counts },
              update: {
                ordersCreated: { increment: counts.ordersCreated },
                milestonesFunded: { increment: counts.milestonesFunded },
                advancesFunded: { increment: counts.advancesFunded },
                milestonesSettled: { increment: counts.milestonesSettled },
                milestonesRefunded: { increment: counts.milestonesRefunded },
                disputesOpened: { increment: counts.disputesOpened },
              },
            });
          }
        }

        ingested += 1;
        if (didProject) {
          projected += 1;
        }
      }

      const last = events.at(-1);
      // The cursor moves only here, inside the same transaction that stored
      // everything above. A throw anywhere in this block rolls the cursor back
      // together with the data, so the indexer can never step over an event it
      // failed to persist.
      await tx.indexerCursor.update({
        where: { cursor_stream: this.ctx },
        data: {
          ...(page.cursor !== undefined ? { lastEventId: page.cursor } : {}),
          ...(last !== undefined
            ? { lastLedger: last.ledger, lastEventAt: last.ledgerClosedAt }
            : {}),
          scannedThroughLedger: page.scannedThroughLedger,
          eventsIngested: { increment: BigInt(ingested) },
          lastPollAt: new Date(),
          lastError: null,
          lastErrorAt: null,
        },
      });
    });

    if (ingested > 0 || duplicates > 0) {
      this.logger.log(
        `indexed page: ingested=${ingested} projected=${projected} duplicates=${duplicates}`,
      );
    }
    return { ingested, projected, duplicates };
  }

  private async recordError(message: string): Promise<void> {
    this.logger.error(message);
    await this.prisma.indexerCursor.updateMany({
      where: this.ctx,
      data: { lastErrorAt: new Date(), lastError: message },
    });
  }

  /**
   * Drop every derived row and rewind the cursor, so the next run rebuilds the
   * read models from chain.
   *
   * This touches nothing on chain. It is always safe in the sense that matters:
   * financial truth is not stored here, so deleting all of it loses nothing that
   * cannot be re-derived.
   *
   * Off-chain metadata (`EvidenceObject`, `AnchorTransaction`) is preserved —
   * it was never derived from events and could not be rebuilt.
   */
  async reset(): Promise<void> {
    await this.ensureCursor();
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id" FROM "IndexerCursor"
        WHERE "network" = ${this.ctx.network} AND "contractId" = ${this.ctx.contractId}
        FOR UPDATE
      `;
      await tx.settlementReadModel.deleteMany({ where: this.ctx });
      await tx.refundReadModel.deleteMany({ where: this.ctx });
      await tx.disputeReadModel.deleteMany({ where: this.ctx });
      await tx.evidenceAnchorReadModel.deleteMany({ where: this.ctx });
      await tx.financePositionReadModel.deleteMany({ where: this.ctx });
      await tx.fundingOfferReadModel.deleteMany({ where: this.ctx });
      await tx.financeRequestReadModel.deleteMany({ where: this.ctx });
      await tx.milestoneReadModel.deleteMany({ where: this.ctx });
      await tx.orderReadModel.deleteMany({ where: this.ctx });
      await tx.indexedContractEvent.deleteMany({ where: this.ctx });
      await tx.analyticsDaily.deleteMany({ where: this.ctx });
      await tx.evidenceObject.updateMany({
        where: this.ctx,
        data: {
          anchoredOnChain: false,
          anchoredAt: null,
          anchoredTxHash: null,
          milestoneRowId: null,
        },
      });
      await tx.indexerCursor.updateMany({
        where: this.ctx,
        data: {
          lastEventId: null,
          lastLedger: null,
          scannedThroughLedger: null,
          eventsIngested: 0n,
          lastError: null,
          lastErrorAt: null,
        },
      });
    });
    this.logger.warn('indexer reset: derived read models dropped, cursor rewound');
  }

  /** Chain head as the RPC reports it, for lag reporting. */
  async chainHead(): Promise<bigint> {
    return this.rpc.latestLedger();
  }
}

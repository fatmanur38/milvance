import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import type { Prisma } from '../generated/prisma/client';
import type { ApiConfig, IndexerTickLimits } from '../config';
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

/**
 * The outcome of one bounded tick, small enough to be an HTTP response and
 * free of anything an operator could not paste into a support channel.
 */
export interface IndexerTickResult {
  /**
   * `already_running` means another tick holds the stream and `throttled`
   * means a cooldown declined to start one. Neither is an error: the work is
   * simply somebody else's turn.
   */
  readonly status: 'ran' | 'already_running' | 'throttled';
  readonly fromLedger: string | null;
  readonly toLedger: string | null;
  readonly pagesFetched: number;
  readonly eventsProcessed: number;
  readonly eventsProjected: number;
  readonly duplicatesSkipped: number;
  /** False when a limit stopped the tick with backlog left to do. */
  readonly caughtUp: boolean;
  readonly durationMs: number;
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

  /**
   * Create the cursor row for this stream if it does not exist yet.
   *
   * Written as a single `ON CONFLICT DO NOTHING` because this is the one
   * moment two workers can race outside the `FOR UPDATE` lock: before the row
   * exists there is nothing to lock. A Prisma `upsert` cannot be used here —
   * with an empty `update` it has no `SET` clause to offer PostgreSQL, so it
   * degrades to a read followed by an insert, and both workers read "absent".
   */
  async ensureCursor() {
    await this.prisma.$executeRaw`
      INSERT INTO "IndexerCursor" ("id", "network", "contractId", "startLedger", "updatedAt")
      VALUES (
        ${randomUUID()},
        ${this.ctx.network},
        ${this.ctx.contractId},
        ${this.config.indexer.startLedger},
        NOW()
      )
      ON CONFLICT ("network", "contractId") DO NOTHING
    `;
    return this.prisma.indexerCursor.findUniqueOrThrow({ where: { cursor_stream: this.ctx } });
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
    return this.run({
      maxPages,
      // A worker run is bounded by pages only. Nothing is waiting on it, so
      // there is no deadline to respect and no reason to stop early.
      maxEvents: Number.POSITIVE_INFINITY,
      maxSeconds: Number.POSITIVE_INFINITY,
    });
  }

  /**
   * One bounded unit of indexing, safe to trigger from an external scheduler.
   *
   * This is the SAME ingestion path `catchUp` uses — the projector, the cursor
   * discipline and the transaction boundaries are not duplicated or relaxed.
   * The only differences are that it stops at a limit instead of at chain head,
   * and that it takes a lease first so a scheduler firing on top of a running
   * tick is a no-op rather than a second writer.
   *
   * Stopping early is not data loss. The cursor only ever advances over events
   * that were stored, so `caughtUp: false` simply means the next tick has work
   * waiting for it.
   */
  async tick(limits: IndexerTickLimits = this.config.indexer.tick): Promise<IndexerTickResult> {
    const startedAt = Date.now();
    const idle = (status: IndexerTickResult['status'], from: string | null): IndexerTickResult => ({
      status,
      fromLedger: from,
      toLedger: from,
      pagesFetched: 0,
      eventsProcessed: 0,
      eventsProjected: 0,
      duplicatesSkipped: 0,
      caughtUp: false,
      durationMs: Date.now() - startedAt,
    });

    const before = await this.ensureCursor();
    const fromLedger = before.scannedThroughLedger?.toString() ?? null;

    // Same process, already indexing: answer immediately rather than queue.
    if (this.running) {
      return idle('already_running', fromLedger);
    }

    const owner = randomUUID();
    // The lease outlives the work it guards, then lapses on its own, so a
    // process killed mid-tick cannot wedge the stream.
    const leaseSeconds = Number.isFinite(limits.maxSeconds)
      ? Math.ceil(limits.maxSeconds * 2 + 30)
      : 300;
    if (!(await this.acquireTickLease(owner, leaseSeconds))) {
      return idle('already_running', fromLedger);
    }

    try {
      const result = await this.run(limits);
      const after = await this.prisma.indexerCursor.findUniqueOrThrow({
        where: { cursor_stream: this.ctx },
      });
      return {
        status: 'ran',
        fromLedger,
        toLedger: after.scannedThroughLedger?.toString() ?? null,
        pagesFetched: result.pagesFetched,
        eventsProcessed: result.eventsIngested,
        eventsProjected: result.eventsProjected,
        duplicatesSkipped: result.duplicatesSkipped,
        caughtUp: result.caughtUp,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      await this.releaseTickLease(owner);
    }
  }

  /**
   * Claim the right to index this stream for a while.
   *
   * A conditional UPDATE rather than a session advisory lock: Prisma pools
   * connections, so a lock taken on one connection may be released from
   * another. A row with an expiry is honest about both cases that matter — a
   * tick still running, and a tick whose process died.
   */
  private async acquireTickLease(owner: string, seconds: number): Promise<boolean> {
    const claimed = await this.prisma.$executeRaw`
      UPDATE "IndexerCursor"
         SET "tickLeaseOwner" = ${owner},
             "tickLeaseUntil" = NOW() + (${seconds} * INTERVAL '1 second'),
             "updatedAt" = NOW()
       WHERE "network" = ${this.ctx.network}
         AND "contractId" = ${this.ctx.contractId}
         AND ("tickLeaseUntil" IS NULL OR "tickLeaseUntil" < NOW())
    `;
    return claimed === 1;
  }

  /** Release only our own lease: a lapsed one may already belong to someone else. */
  private async releaseTickLease(owner: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "IndexerCursor"
         SET "tickLeaseOwner" = NULL, "tickLeaseUntil" = NULL, "updatedAt" = NOW()
       WHERE "network" = ${this.ctx.network}
         AND "contractId" = ${this.ctx.contractId}
         AND "tickLeaseOwner" = ${owner}
    `;
  }

  /**
   * The ingestion loop. Every mode of this indexer goes through here.
   */
  private async run(limits: IndexerTickLimits): Promise<IndexerRunResult> {
    if (this.running) {
      throw new Error('indexer run already in progress in this process');
    }
    this.running = true;
    const deadline = Date.now() + limits.maxSeconds * 1000;
    let pagesFetched = 0;
    let eventsIngested = 0;
    let eventsProjected = 0;
    let duplicatesSkipped = 0;
    let latestLedger = 0n;
    let caughtUp = false;

    try {
      // Limits are checked between pages, never inside one: a page is stored
      // whole or not at all, and no event is ever skipped to finish sooner.
      while (pagesFetched < limits.maxPages) {
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
            // fetched it. Read the new cursor and fetch again. The retry costs
            // a page of budget, so this can never spin.
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
        if (eventsIngested >= limits.maxEvents || Date.now() >= deadline) {
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

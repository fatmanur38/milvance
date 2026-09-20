import { createHash, timingSafeEqual } from 'node:crypto';

import {
  Controller,
  Headers,
  HttpCode,
  Inject,
  Logger,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

import type { ApiConfig } from '../config';
import { API_CONFIG } from '../tokens';
import { IndexerService, type IndexerTickResult } from './indexer.service';

/**
 * Operational endpoints that advance the indexer.
 *
 * The free-tier deployment has no always-running worker, so an external
 * scheduler calls `POST /api/internal/indexer/tick` once a minute and that is
 * what keeps the read model current. The endpoint is a trigger and nothing
 * more: it carries no ledger range, accepts no event payload and has no
 * request body at all. Everything it indexes is read from the configured
 * Stellar RPC by the same code the CLI worker runs.
 *
 * What it therefore cannot be used for, by construction:
 *
 *   - inserting a financial event that the contract did not emit
 *   - rewinding, fast-forwarding or otherwise choosing a cursor
 *   - replaying or resetting the read model
 *   - signing anything
 */

/** Compare without leaking how much of the secret was right. */
function secretMatches(presented: string, expected: string): boolean {
  // Hash first so both sides are the same length; `timingSafeEqual` throws on
  // a length mismatch, which would itself be an oracle.
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** `Authorization: Bearer <secret>`, or nothing. */
function bearer(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match?.[1];
}

@Controller()
export class IndexerController {
  private readonly logger = new Logger(IndexerController.name);
  /** Earliest time an unauthenticated nudge may run again, in epoch ms. */
  private nextPublicTickAt = 0;

  constructor(
    private readonly indexer: IndexerService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  /**
   * Run one bounded tick. For the scheduler, and for an operator with the
   * secret — nobody else.
   */
  @Post('internal/indexer/tick')
  @HttpCode(200)
  async scheduledTick(
    @Headers('authorization') authorization?: string,
  ): Promise<IndexerTickResult> {
    const expected = this.config.indexer.cronSecret;
    if (expected === undefined) {
      // No secret configured means no endpoint. Never fall back to open.
      throw new ServiceUnavailableException('Scheduled indexing is not configured');
    }
    const presented = bearer(authorization);
    if (presented === undefined || !secretMatches(presented, expected)) {
      // The secret is never echoed, and neither is the fact that one was sent.
      this.logger.warn('rejected an unauthenticated indexer tick');
      throw new UnauthorizedException();
    }
    return this.indexer.tick();
  }

  /**
   * A small public nudge, so a user who just signed a transaction is not
   * waiting on the next scheduled tick to see their own action.
   *
   * It is the same tick, with a smaller budget and a cooldown. It cannot be
   * aimed: no body, no cursor, no ledger. The worst an abuser achieves is the
   * work the scheduler was going to do anyway, and no more often than the
   * cooldown allows.
   */
  @Post('indexer/catch-up')
  @HttpCode(200)
  async publicCatchUp(): Promise<IndexerTickResult> {
    const now = Date.now();
    if (now < this.nextPublicTickAt) {
      // Say so plainly rather than pretending a tick ran. The caller is
      // polling anyway, and the scheduler is still behind this.
      const status = await this.indexer.status();
      return {
        status: 'throttled',
        fromLedger: status.scannedThroughLedger,
        toLedger: status.scannedThroughLedger,
        pagesFetched: 0,
        eventsProcessed: 0,
        eventsProjected: 0,
        duplicatesSkipped: 0,
        caughtUp: false,
        durationMs: 0,
      };
    }
    this.nextPublicTickAt = now + PUBLIC_TICK_COOLDOWN_MS;
    return this.indexer.tick(PUBLIC_TICK_LIMITS);
  }
}

/** Enough to surface the transaction a user just signed, and not a backfill. */
const PUBLIC_TICK_LIMITS = { maxPages: 2, maxEvents: 200, maxSeconds: 5 } as const;
const PUBLIC_TICK_COOLDOWN_MS = 3_000;

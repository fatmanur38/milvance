import { decodeEvent, type DecodedEvent, type RawContractEvent } from './decoder';

/**
 * Minimal Soroban RPC event source.
 *
 * Deliberately hand-rolled over `fetch` rather than wrapped around an SDK
 * client: the indexer needs the raw paging cursor and the exact `id` of every
 * event, which is what makes resumption and deduplication exact. A convenience
 * wrapper that normalised those away would cost the properties this package
 * exists to provide.
 */

export interface EventPage {
  readonly events: DecodedEvent[];
  /** RPC paging cursor to resume from, when the RPC returned one. */
  readonly cursor: string | undefined;
  /** Latest ledger the RPC has seen; used to report indexing lag. */
  readonly latestLedger: bigint;
  /** Highest ledger covered by this response. */
  readonly scannedThroughLedger: bigint;
}

export interface EventQuery {
  readonly contractId: string;
  /** Start of the scan. Ignored when `cursor` is set. */
  readonly startLedger?: bigint;
  /** Resume point from a previous page. */
  readonly cursor?: string;
  readonly limit?: number;
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

/** Thrown when the requested start ledger has aged out of the RPC's window. */
export class LedgerOutOfRangeError extends RpcError {
  constructor(
    message: string,
    readonly oldestLedger: bigint | undefined,
  ) {
    super(message);
    this.name = 'LedgerOutOfRangeError';
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface JsonRpcResponse<T> {
  result?: T;
  error?: { code: number; message: string };
}

const OUT_OF_RANGE = /must be within the ledger range:\s*(\d+)\s*-\s*(\d+)/i;

export class SorobanRpc {
  constructor(
    private readonly url: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async call<T>(method: string, params: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
    } catch {
      throw new RpcError(`Soroban RPC unreachable (${method})`, undefined);
    }
    if (!response.ok) {
      throw new RpcError(`Soroban RPC returned HTTP ${response.status} for ${method}`);
    }
    const body = (await response.json()) as JsonRpcResponse<T>;
    if (body.error !== undefined) {
      const match = OUT_OF_RANGE.exec(body.error.message);
      if (match !== null) {
        throw new LedgerOutOfRangeError(body.error.message, BigInt(match[1] as string));
      }
      throw new RpcError(body.error.message, body.error.code);
    }
    if (body.result === undefined) {
      throw new RpcError(`Soroban RPC returned no result for ${method}`);
    }
    return body.result;
  }

  /** Current ledger height, used for health and lag reporting. */
  async latestLedger(): Promise<bigint> {
    const result = await this.call<{ sequence: number }>('getLatestLedger', {});
    return BigInt(result.sequence);
  }

  /**
   * Fetch one page of contract events.
   *
   * A decode failure is NOT swallowed: it propagates so the caller can abort the
   * batch and leave the cursor untouched. Skipping an undecodable event would
   * silently drop chain history from the read model.
   */
  async getEvents(query: EventQuery): Promise<EventPage> {
    const pagination: Record<string, unknown> = { limit: query.limit ?? 100 };
    const params: Record<string, unknown> = {
      filters: [{ type: 'contract', contractIds: [query.contractId] }],
      pagination,
      xdrFormat: 'base64',
    };
    if (query.cursor !== undefined) {
      pagination.cursor = query.cursor;
    } else if (query.startLedger !== undefined) {
      params.startLedger = Number(query.startLedger);
    }

    const result = await this.call<{
      events: RawContractEvent[];
      cursor?: string;
      latestLedger: number;
      oldestLedger?: number;
    }>('getEvents', params);

    const events = (result.events ?? []).map(decodeEvent);
    const latestLedger = BigInt(result.latestLedger);
    const highestEventLedger = events.reduce<bigint>(
      (highest, event) => (event.ledger > highest ? event.ledger : highest),
      0n,
    );

    return {
      events,
      cursor: result.cursor,
      latestLedger,
      // With no events, the page still covered ground: trust the RPC's own
      // notion of how far it scanned so empty ranges are not rescanned forever.
      scannedThroughLedger: highestEventLedger > 0n ? highestEventLedger : latestLedger,
    };
  }
}

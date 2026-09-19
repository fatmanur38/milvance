import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiConfig } from '../config';
import type { PrismaClient } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { IndexerService, redactError } from './indexer.service';
import {
  ADDRESSES,
  CONTRACT_ID,
  NETWORK,
  rawEvent,
  resetFixtureSequence,
} from './fixtures.test-helper';
import { LedgerOutOfRangeError, SorobanRpc } from './rpc';
import { hasTestDatabase, TEST_DATABASE_URL, testClient, truncateAll } from './test-db.test-helper';

/**
 * Indexer behaviour against a real database.
 *
 * The properties asserted here are the ones the package exists to provide:
 * idempotency, an honest cursor, restart, replay, and — most importantly —
 * that a failure does NOT advance the cursor past the event that failed.
 */
const suite = hasTestDatabase ? describe : describe.skip;

function config(): ApiConfig {
  return {
    port: 3001,
    nodeEnv: 'test',
    databaseUrl: TEST_DATABASE_URL ?? '',
    stellar: {
      network: NETWORK,
      networkPassphrase: 'Test SDF Network ; September 2015',
      rpcUrl: 'https://rpc.invalid',
      horizonUrl: 'https://horizon.invalid',
      contractId: CONTRACT_ID,
      usdcIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      usdcAssetContractId: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    },
    indexer: { startLedger: 4_760_000n, pollIntervalSeconds: 10 },
    evidence: {
      driver: 'local-dev',
      localDirectory: '.evidence-test',
      maxBytes: 1024,
      endpoint: undefined,
      bucket: undefined,
    },
  };
}

/** A fake RPC that serves pre-built pages, so tests need no network. */
function fakeRpc(pages: { events: unknown[]; cursor?: string }[]): SorobanRpc {
  let call = 0;
  const rpc = new SorobanRpc('https://rpc.invalid');
  vi.spyOn(rpc, 'getEvents').mockImplementation(async () => {
    const page = pages[call] ?? { events: [] };
    call += 1;
    const { decodeEvent } = await import('./decoder');
    const decoded = page.events.map((raw) => decodeEvent(raw as Parameters<typeof decodeEvent>[0]));
    return {
      events: decoded,
      cursor: page.cursor ?? `cursor-${call}`,
      latestLedger: 4_770_000n,
      scannedThroughLedger: 4_770_000n,
    };
  });
  vi.spyOn(rpc, 'latestLedger').mockResolvedValue(4_770_000n);
  return rpc;
}

const ORDER_FIELDS = {
  buyer: ADDRESSES.buyer,
  supplier: ADDRESSES.supplier,
  attestor: ADDRESSES.attestor,
  resolver: ADDRESSES.resolver,
  asset: ADDRESSES.usdcSac,
};

suite('indexer', () => {
  const raw: PrismaClient = hasTestDatabase ? testClient() : (undefined as unknown as PrismaClient);
  const prisma = raw as unknown as PrismaService;

  beforeEach(async () => {
    resetFixtureSequence();
    await truncateAll(raw);
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await raw?.$disconnect();
  });

  it('ingests a page and advances the cursor', async () => {
    const events = [rawEvent('order_created', { order_id: 1n, ...ORDER_FIELDS })];
    const indexer = new IndexerService(prisma, config(), fakeRpc([{ events, cursor: 'c1' }]));

    // One page only: a full catch-up would also fetch the empty follow-up page
    // and store its cursor, which would obscure what is being asserted here.
    const result = await indexer.catchUp(1);

    expect(result.eventsIngested).toBe(1);
    expect(result.eventsProjected).toBe(1);
    expect(await raw.orderReadModel.count()).toBe(1);
    expect((await raw.analyticsDaily.findFirstOrThrow()).ordersCreated).toBe(1);

    const status = await indexer.status();
    expect(status.lastEventId).toBe('c1');
    expect(status.eventsIngested).toBe('1');
  });

  it('is idempotent: re-delivering the same events creates no duplicates', async () => {
    const events = [
      rawEvent('order_created', { order_id: 1n, ...ORDER_FIELDS }),
      rawEvent('order_accepted', { order_id: 1n, supplier: ADDRESSES.supplier }),
    ];

    const first = new IndexerService(prisma, config(), fakeRpc([{ events }]));
    await first.catchUp(2);

    // A second pass serving the very same events — what a cursor reset or an
    // overlapping page would produce.
    const second = new IndexerService(prisma, config(), fakeRpc([{ events }]));
    const result = await second.catchUp(2);

    expect(result.duplicatesSkipped).toBe(2);
    expect(result.eventsIngested).toBe(0);
    expect(await raw.indexedContractEvent.count()).toBe(2);
    expect(await raw.orderReadModel.count()).toBe(1);
    expect((await raw.analyticsDaily.findFirstOrThrow()).ordersCreated).toBe(1);
  });

  it('cannot double-ingest even if the unique guard is bypassed', async () => {
    const event = rawEvent('order_created', { order_id: 1n, ...ORDER_FIELDS });
    const indexer = new IndexerService(prisma, config(), fakeRpc([{ events: [event] }]));
    await indexer.catchUp(2);

    const stored = await raw.indexedContractEvent.findFirstOrThrow();
    // The database itself refuses a second row with the same chain identity.
    await expect(
      raw.indexedContractEvent.create({
        data: {
          network: stored.network,
          contractId: stored.contractId,
          eventId: stored.eventId,
          ledger: stored.ledger,
          txHash: stored.txHash,
          eventIndex: stored.eventIndex,
          txIndex: stored.txIndex,
          operationIndex: stored.operationIndex,
          eventName: stored.eventName,
          successful: stored.successful,
          ledgerClosedAt: stored.ledgerClosedAt,
          payload: {},
          topicsXdr: [],
          valueXdr: '',
        },
      }),
    ).rejects.toThrow();
  });

  it('resumes from the persisted cursor after a restart', async () => {
    const page1 = [rawEvent('order_created', { order_id: 1n, ...ORDER_FIELDS })];
    const page2 = [rawEvent('order_accepted', { order_id: 1n, supplier: ADDRESSES.supplier })];

    const before = new IndexerService(prisma, config(), fakeRpc([{ events: page1, cursor: 'c1' }]));
    await before.catchUp(1);
    expect((await before.status()).lastEventId).toBe('c1');

    // A brand-new service instance: nothing is carried in memory.
    const rpc = fakeRpc([{ events: page2, cursor: 'c2' }]);
    const after = new IndexerService(prisma, config(), rpc);
    await after.catchUp(1);

    const getEvents = vi.mocked(rpc.getEvents);
    expect(getEvents.mock.calls[0]?.[0]).toMatchObject({ cursor: 'c1' });
    expect((await after.status()).lastEventId).toBe('c2');
    expect((await raw.orderReadModel.findFirstOrThrow()).status).toBe('ACTIVE');
  });

  it('does NOT advance the cursor when an event in the batch fails', async () => {
    // A milestone event with no preceding `milestone_created` cannot be
    // projected honestly, so the batch must fail whole.
    const events = [
      rawEvent('order_created', { order_id: 1n, ...ORDER_FIELDS }),
      rawEvent('milestone_funded', {
        order_id: 1n,
        milestone_id: 404n,
        buyer: ADDRESSES.buyer,
        amount: 1n,
        funded_amount: 1n,
        fully_funded: true,
      }),
    ];
    const indexer = new IndexerService(prisma, config(), fakeRpc([{ events, cursor: 'c1' }]));

    await expect(indexer.catchUp(1)).rejects.toThrow();

    const status = await indexer.status();
    // The cursor never moved past the failure...
    expect(status.lastEventId).toBeNull();
    // ...and nothing from the failed batch was committed, not even the first
    // event, which on its own would have succeeded.
    expect(await raw.orderReadModel.count()).toBe(0);
    expect(await raw.indexedContractEvent.count()).toBe(0);
    expect(await raw.analyticsDaily.count()).toBe(0);
  });

  it('retries the same events after a failure is resolved', async () => {
    const good = rawEvent('order_created', { order_id: 1n, ...ORDER_FIELDS });
    const bad = rawEvent('milestone_funded', {
      order_id: 1n,
      milestone_id: 404n,
      buyer: ADDRESSES.buyer,
      amount: 1n,
      funded_amount: 1n,
      fully_funded: true,
    });

    const failing = new IndexerService(prisma, config(), fakeRpc([{ events: [good, bad] }]));
    await expect(failing.catchUp(1)).rejects.toThrow();

    // The upstream problem is gone; the same page now contains only what can be
    // projected. Because the cursor never advanced, nothing was lost.
    const recovered = new IndexerService(prisma, config(), fakeRpc([{ events: [good] }]));
    const result = await recovered.catchUp(1);

    expect(result.eventsIngested).toBe(1);
    expect(await raw.orderReadModel.count()).toBe(1);
    expect((await raw.analyticsDaily.findFirstOrThrow()).ordersCreated).toBe(1);
  });

  it('applies events in deterministic chain order regardless of delivery order', async () => {
    const created = rawEvent('order_created', { order_id: 1n, ...ORDER_FIELDS });
    const accepted = rawEvent('order_accepted', { order_id: 1n, supplier: ADDRESSES.supplier });

    // Delivered newest-first; the indexer must still apply creation first.
    const indexer = new IndexerService(
      prisma,
      config(),
      fakeRpc([{ events: [accepted, created] }]),
    );
    await indexer.catchUp(1);

    expect((await raw.orderReadModel.findFirstOrThrow()).status).toBe('ACTIVE');
  });

  it('rebuilds derived read models from chain on replay, keeping off-chain metadata', async () => {
    const events = [
      rawEvent('order_created', { order_id: 1n, ...ORDER_FIELDS }),
      rawEvent('milestone_created', {
        order_id: 1n,
        milestone_id: 1n,
        index: 0,
        amount: 5_000_0000000n,
        deadline: null,
      }),
    ];
    await new IndexerService(prisma, config(), fakeRpc([{ events }])).catchUp(1);
    await raw.anchorTransaction.create({
      data: {
        network: NETWORK,
        anchorDomain: 'tr-mock-anchor.fly.dev',
        direction: 'TRY_TO_USDC',
        walletAddress: ADDRESSES.buyer,
        sourceAsset: 'iso4217:TRY',
        destinationAsset: 'USDC',
        status: 'completed',
      },
    });

    const replaying = new IndexerService(prisma, config(), fakeRpc([{ events }]));
    await replaying.reset();

    expect(await raw.orderReadModel.count()).toBe(0);
    expect(await raw.milestoneReadModel.count()).toBe(0);
    expect(await raw.indexedContractEvent.count()).toBe(0);
    expect((await replaying.status()).lastEventId).toBeNull();
    // Off-chain metadata could not be rebuilt from chain, so it survives.
    expect(await raw.anchorTransaction.count()).toBe(1);

    const result = await replaying.catchUp(1);
    expect(result.eventsIngested).toBe(2);
    expect(await raw.orderReadModel.count()).toBe(1);
    expect((await raw.milestoneReadModel.findFirstOrThrow()).amount.toFixed(0)).toBe('50000000000');
  });

  it('refuses events emitted by a different contract', async () => {
    const foreign = rawEvent(
      'order_created',
      { order_id: 1n, ...ORDER_FIELDS },
      { contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    );
    const indexer = new IndexerService(prisma, config(), fakeRpc([{ events: [foreign] }]));

    await expect(indexer.catchUp(1)).rejects.toThrow(/is from contract/);
    expect(await raw.orderReadModel.count()).toBe(0);
  });

  it('fails closed when RPC history has aged out instead of rewinding over a gap', async () => {
    const rpc = fakeRpc([]);
    vi.mocked(rpc.getEvents).mockRejectedValueOnce(
      new LedgerOutOfRangeError('old history unavailable', 4_765_000n),
    );
    const indexer = new IndexerService(prisma, config(), rpc);

    await expect(indexer.catchUp(1)).rejects.toThrow(LedgerOutOfRangeError);
    const status = await indexer.status();
    expect(status.startLedger).toBe('4760000');
    expect(status.lastEventId).toBeNull();
    expect(status.lastError).toMatch(/history is outside RPC retention/);
  });

  it('serializes two workers that fetch the same page and keeps one projection', async () => {
    const event = rawEvent('order_created', { order_id: 1n, ...ORDER_FIELDS });
    const { decodeEvent } = await import('./decoder');
    let arrived = 0;
    let release!: () => void;
    const bothFetched = new Promise<void>((resolve) => {
      release = resolve;
    });
    const makeRpc = () => {
      const rpc = new SorobanRpc('https://rpc.invalid');
      let calls = 0;
      vi.spyOn(rpc, 'getEvents').mockImplementation(async () => {
        calls += 1;
        if (calls === 1) {
          arrived += 1;
          if (arrived === 2) release();
          await bothFetched;
          return {
            events: [decodeEvent(event)],
            cursor: 'c1',
            latestLedger: 4_770_000n,
            scannedThroughLedger: 4_770_000n,
          };
        }
        return {
          events: [],
          cursor: `end-${calls}`,
          latestLedger: 4_770_000n,
          scannedThroughLedger: 4_770_000n,
        };
      });
      return rpc;
    };
    const first = new IndexerService(prisma, config(), makeRpc());
    const second = new IndexerService(prisma, config(), makeRpc());

    await Promise.all([first.catchUp(2), second.catchUp(2)]);
    expect(await raw.indexedContractEvent.count()).toBe(1);
    expect(await raw.orderReadModel.count()).toBe(1);
    expect((await first.status()).eventsIngested).toBe('1');
    expect((await raw.analyticsDaily.findFirstOrThrow()).ordersCreated).toBe(1);
  });

  it('surfaces a successful event it cannot project instead of looking healthy', async () => {
    // A newer contract emitting an event this build has no projection for.
    const { xdr } = await import('@stellar/stellar-sdk');
    const future = rawEvent('order_created', { order_id: 1n, ...ORDER_FIELDS });
    future.topic[0] = xdr.ScVal.scvSymbol('future_event').toXDR('base64');
    // A known event from a reverted call: recorded, never projected, and NOT a
    // coverage gap, because the chain never adopted it.
    const reverted = rawEvent(
      'order_created',
      { order_id: 2n, ...ORDER_FIELDS },
      { successful: false },
    );
    const indexer = new IndexerService(prisma, config(), fakeRpc([{ events: [future, reverted] }]));

    await indexer.catchUp(1);

    // Both are durably stored (auditability) and the cursor moved past them...
    expect(await raw.indexedContractEvent.count()).toBe(2);
    expect(await raw.orderReadModel.count()).toBe(0);
    // ...but only the successful one counts as missing projection support,
    // which is what drives readiness to `degraded`.
    const status = await indexer.status();
    expect(status.unprojectedSuccessfulEvents).toBe(1);
  });

  it('reports a chain-order status without a network call', async () => {
    const indexer = new IndexerService(prisma, config(), fakeRpc([{ events: [] }]));
    const status = await indexer.status();

    expect(status.network).toBe(NETWORK);
    expect(status.contractId).toBe(CONTRACT_ID);
    expect(status.startLedger).toBe('4760000');
    expect(status.lastError).toBeNull();
  });
});

describe('error redaction', () => {
  it('strips a connection string that carries a password', () => {
    const fixtureDsn = [
      'postgresql://',
      'user:',
      'example-only',
      '@db.example.com:5432/milvance',
    ].join('');
    const message = redactError(new Error(`connect failed for ${fixtureDsn}`));

    expect(message).not.toContain('example-only');
    expect(message).toContain('[redacted]');
  });

  it('strips a Stellar secret key shape', () => {
    const message = redactError(new Error(`bad key SA${'B'.repeat(54)}`));
    expect(message).toContain('[redacted-secret-key]');
  });

  it('strips a JWT shape', () => {
    const message = redactError(new Error('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhIn0.sig'));
    expect(message).toContain('[redacted-jwt]');
    expect(message).not.toContain('eyJzdWIiOiJhIn0');
  });

  it('caps runaway error text', () => {
    expect(redactError(new Error('x'.repeat(5000))).length).toBeLessThanOrEqual(500);
  });
});

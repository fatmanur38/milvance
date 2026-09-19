import { describe, expect, it, vi } from 'vitest';

import type { ApiConfig } from '../config';
import type { IndexerService } from '../indexer/indexer.service';
import type { PrismaService } from '../prisma/prisma.service';
import { HealthController } from './health.controller';

const config = {
  stellar: {
    network: 'testnet',
    contractId: 'CCN6AZHLN2BQPCDZWXJGA3NRJEJ56V5JK3M4VZ5QFKQ3NSJBN6RVTKRX',
  },
} as ApiConfig;

describe('health and readiness', () => {
  it('keeps liveness separate from database and RPC availability', async () => {
    const fixtureDsn = ['postgresql://', 'user:', 'example-only', '@host/db'].join('');
    const prisma = {
      ping: vi.fn().mockRejectedValue(new Error(fixtureDsn)),
    } as unknown as PrismaService;
    const indexer = {
      chainHead: vi.fn().mockRejectedValue(new Error('RPC unavailable')),
      status: vi.fn().mockRejectedValue(new Error('DB unavailable')),
    } as unknown as IndexerService;
    const health = new HealthController(prisma, indexer, config);

    expect(health.health().status).toBe('ok');
    const readiness = await health.ready();
    expect(readiness.status).toBe('down');
    expect(readiness.checks.database.detail).toBe('PostgreSQL is not reachable');
    expect(JSON.stringify(readiness)).not.toContain('example-only');
  });

  it('reports indexer lag without declaring an old projection healthy', async () => {
    const prisma = { ping: vi.fn().mockResolvedValue(undefined) } as unknown as PrismaService;
    const indexer = {
      chainHead: vi.fn().mockResolvedValue(4_770_000n),
      status: vi.fn().mockResolvedValue({ scannedThroughLedger: '4760000', lastError: null }),
    } as unknown as IndexerService;
    const readiness = await new HealthController(prisma, indexer, config).ready();

    expect(readiness.status).toBe('degraded');
    expect(readiness.checks.indexer.detail).toMatch(/ledgers behind/);
  });

  it('marks unknown successful events as degraded', async () => {
    const prisma = { ping: vi.fn().mockResolvedValue(undefined) } as unknown as PrismaService;
    const indexer = {
      chainHead: vi.fn().mockResolvedValue(4_770_000n),
      status: vi.fn().mockResolvedValue({
        scannedThroughLedger: '4770000',
        lastError: null,
        unprojectedSuccessfulEvents: 1,
      }),
    } as unknown as IndexerService;
    const readiness = await new HealthController(prisma, indexer, config).ready();
    expect(readiness.status).toBe('degraded');
    expect(readiness.checks.indexer.detail).toMatch(/need projection support/);
  });
});

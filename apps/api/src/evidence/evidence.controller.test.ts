import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../config';
import type { PrismaService } from '../prisma/prisma.service';
import { EvidenceController } from './evidence.controller';
import { hashEvidence } from './hash';
import type { EvidenceStorage } from './storage';

const config = loadConfig({
  DATABASE_URL: 'postgresql://localhost/test',
  MILVANCE_CONTRACT_ID: 'CCN6AZHLN2BQPCDZWXJGA3NRJEJ56V5JK3M4VZ5QFKQ3NSJBN6RVTKRX',
  USDC_ISSUER: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  USDC_ASSET_CONTRACT_ID: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  EVIDENCE_MAX_BYTES: '16',
});

describe('evidence upload boundary', () => {
  const bytes = Buffer.from('QC pass');
  const contentBase64 = bytes.toString('base64');

  function subject() {
    const put = vi.fn(async () => 'evidence/test');
    const upsert = vi.fn(async () => ({
      contentHash: hashEvidence(bytes),
      byteSize: BigInt(bytes.length),
      filename: 'qc.pdf',
      mimeType: 'application/pdf',
      documentLabel: null,
      anchoredOnChain: false,
      storageDriver: 'local-dev',
    }));
    const prisma = { evidenceObject: { upsert } } as unknown as PrismaService;
    const storage = { driver: 'local-dev', put } as unknown as EvidenceStorage;
    return { controller: new EvidenceController(prisma, storage, config), put, upsert };
  }

  it('rejects a claimed hash mismatch before storing bytes', async () => {
    const { controller, put } = subject();
    await expect(
      controller.complete({ contentBase64, expectedHash: '0'.repeat(64) }),
    ).rejects.toThrow(/does not match/);
    expect(put).not.toHaveBeenCalled();
  });

  it('rejects malformed base64 and oversized documents', async () => {
    const { controller, put } = subject();
    await expect(controller.complete({ contentBase64: '%%%%' })).rejects.toThrow(
      /canonical base64/,
    );
    await expect(
      controller.complete({ contentBase64: Buffer.alloc(17).toString('base64') }),
    ).rejects.toThrow(/byte limit/);
    expect(put).not.toHaveBeenCalled();
  });

  it('returns the digest for wallet signing and stores only metadata', async () => {
    const { controller, put, upsert } = subject();
    const result = await controller.complete({
      contentBase64,
      expectedHash: hashEvidence(bytes),
      filename: '../../qc.pdf',
    });
    expect(result.contentHash).toBe(hashEvidence(bytes));
    expect(result.nextStep.action).toBe('submit_evidence');
    expect(put).toHaveBeenCalledWith(hashEvidence(bytes), bytes);
    const stored = upsert.mock.calls[0]?.[0];
    expect(stored?.create.filename).toBe('qc.pdf');
    expect(stored?.create).not.toHaveProperty('contentBase64');
  });
});

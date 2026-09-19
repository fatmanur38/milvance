import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';

import type { ApiConfig } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import {
  hashEvidence,
  isEvidenceHash,
  normaliseEvidenceHash,
  sanitiseFilename,
  storageKeyFor,
} from './hash';
import { API_CONFIG, EVIDENCE_STORAGE } from '../tokens';
import type { EvidenceStorage } from './storage';

/**
 * Evidence metadata.
 *
 * This is OFF-CHAIN metadata, which is why it may be written over HTTP at all —
 * unlike anything in `ReadController`. What it emphatically does not do is
 * decide that a milestone is verified: recording a document here proves only
 * that bytes were uploaded and hashed.
 *
 * The flow (AGENT.md §26):
 *
 *   upload -> hash -> object storage -> show the hash
 *   -> THE SUPPLIER'S WALLET signs `submit_evidence(hash)`
 *
 * The backend never performs that last step. It cannot: it holds no key.
 * Only when the indexer later observes the matching `evidence_submitted` event
 * does `anchoredOnChain` become true.
 */

const MAX_LABEL_LENGTH = 120;
const ALLOWED_MIME = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i;

interface CompleteUploadBody {
  contentBase64?: unknown;
  expectedHash?: unknown;
  filename?: unknown;
  mimeType?: unknown;
  documentLabel?: unknown;
  uploadedBy?: unknown;
  milestoneId?: unknown;
}

@Controller('evidence')
export class EvidenceController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(EVIDENCE_STORAGE) private readonly storage: EvidenceStorage,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  private get scope() {
    return {
      network: this.config.stellar.network,
      contractId: this.config.stellar.contractId,
    };
  }

  /**
   * Accept a document, hash it, store the bytes and record the metadata.
   *
   * Returns the digest for the supplier to sign. It does not submit anything.
   */
  @Post()
  async complete(@Body() body: CompleteUploadBody) {
    if (
      body === null ||
      typeof body !== 'object' ||
      typeof body.contentBase64 !== 'string' ||
      body.contentBase64 === ''
    ) {
      throw new BadRequestException('contentBase64 is required');
    }

    // Reject oversize input before decoding. Base64 adds at most one third to
    // the byte count; the exact decoded limit is checked below as well.
    if (body.contentBase64.length > Math.ceil(this.config.evidence.maxBytes / 3) * 4 + 4) {
      throw new BadRequestException('Evidence document exceeds the configured byte limit');
    }

    let bytes: Buffer;
    try {
      bytes = Buffer.from(body.contentBase64, 'base64');
    } catch {
      throw new BadRequestException('contentBase64 is not valid base64');
    }
    if (bytes.toString('base64') !== body.contentBase64) {
      throw new BadRequestException('contentBase64 is not canonical base64');
    }
    if (bytes.byteLength === 0) {
      throw new BadRequestException('Evidence document is empty');
    }
    if (bytes.byteLength > this.config.evidence.maxBytes) {
      throw new BadRequestException(
        `Evidence document exceeds the ${this.config.evidence.maxBytes} byte limit`,
      );
    }

    const mimeType = typeof body.mimeType === 'string' ? body.mimeType : 'application/octet-stream';
    if (!ALLOWED_MIME.test(mimeType)) {
      throw new BadRequestException('mimeType is not a valid media type');
    }
    const label =
      typeof body.documentLabel === 'string' ? body.documentLabel.slice(0, MAX_LABEL_LENGTH) : null;
    const uploadedBy = typeof body.uploadedBy === 'string' ? body.uploadedBy : null;
    if (uploadedBy !== null && !/^G[A-Z2-7]{55}$/.test(uploadedBy)) {
      throw new BadRequestException('uploadedBy must be a Stellar public key');
    }
    let milestoneId: bigint | null = null;
    if (body.milestoneId !== undefined) {
      if (typeof body.milestoneId !== 'string') {
        throw new BadRequestException('milestoneId must be a decimal chain ID string');
      }
      const raw = body.milestoneId;
      if (!/^\d+$/.test(raw) || BigInt(raw) === 0n || BigInt(raw) > 9_223_372_036_854_775_807n) {
        throw new BadRequestException('milestoneId must be a positive chain ID');
      }
      milestoneId = BigInt(raw);
    }

    // The digest commits to the DOCUMENT BYTES — not the filename, not this
    // request body, not a URL.
    const contentHash = hashEvidence(bytes);
    if (body.expectedHash !== undefined) {
      if (typeof body.expectedHash !== 'string' || !isEvidenceHash(body.expectedHash)) {
        throw new BadRequestException('expectedHash must be a SHA-256 digest in hex');
      }
      if (normaliseEvidenceHash(body.expectedHash) !== contentHash) {
        throw new BadRequestException('Evidence hash does not match the uploaded bytes');
      }
    }
    const storageKey = await this.storage.put(contentHash, bytes);
    const filename = sanitiseFilename(
      typeof body.filename === 'string' ? body.filename : 'evidence',
    );

    const record = await this.prisma.evidenceObject.upsert({
      where: { evidence_identity: { ...this.scope, contentHash } },
      create: {
        ...this.scope,
        contentHash,
        filename,
        mimeType,
        byteSize: BigInt(bytes.byteLength),
        storageKey,
        storageDriver: this.storage.driver,
        ...(uploadedBy !== null ? { uploadedBy } : {}),
        ...(milestoneId !== null ? { milestoneId } : {}),
        ...(label !== null ? { documentLabel: label } : {}),
      },
      update: {},
    });

    return {
      contentHash: record.contentHash,
      byteSize: record.byteSize.toString(),
      filename: record.filename,
      mimeType: record.mimeType,
      documentLabel: record.documentLabel,
      anchoredOnChain: record.anchoredOnChain,
      storageDriver: record.storageDriver,
      /** What the supplier's wallet must sign. The backend will not sign it. */
      nextStep: {
        action: 'submit_evidence',
        argument: record.contentHash,
        signedBy: 'the supplier, in their own wallet',
      },
    };
  }

  @Get(':contentHash')
  async byHash(@Param('contentHash') contentHash: string) {
    if (!isEvidenceHash(contentHash)) {
      throw new BadRequestException('contentHash must be a SHA-256 digest in hex');
    }
    const digest = normaliseEvidenceHash(contentHash);
    const record = await this.prisma.evidenceObject.findUnique({
      where: { evidence_identity: { ...this.scope, contentHash: digest } },
    });
    if (record === null) {
      throw new NotFoundException('No evidence metadata for that digest');
    }
    return {
      contentHash: record.contentHash,
      filename: record.filename,
      mimeType: record.mimeType,
      byteSize: record.byteSize.toString(),
      documentLabel: record.documentLabel,
      uploadedBy: record.uploadedBy,
      milestoneId: record.milestoneId?.toString() ?? null,
      anchoredOnChain: record.anchoredOnChain,
      anchoredTxHash: record.anchoredTxHash,
      anchoredAt: record.anchoredAt?.toISOString() ?? null,
      storageKey: storageKeyFor(record.contentHash),
      createdAt: record.createdAt.toISOString(),
      /** Stated explicitly: a hash proves the bytes, not the shipment. */
      note: 'The chain stores this digest only. A human attestor decides whether the document is true.',
    };
  }
}

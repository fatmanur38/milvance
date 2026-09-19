import { BadRequestException, Body, Controller, Get, Inject, Post, Query } from '@nestjs/common';

import type { ApiConfig } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { API_CONFIG } from '../tokens';

/**
 * Public-safe read model for Anchor local payments.
 *
 * PKG-07 owns the protocol and keeps owning it: the browser talks to the Anchor
 * directly, holds its own SEP-10 session, and signs its own transactions. This
 * controller re-implements none of that. It only remembers what a completed leg
 * looked like, so product views can connect local money to chain money.
 *
 * What is refused here, deliberately and by name: a SEP-10 JWT, a seed, a
 * private key, a KYC payload, bank account details. If a caller sends one, the
 * request is rejected rather than quietly dropped, because a client that thinks
 * the backend stores its token will keep sending it.
 */

const FORBIDDEN_FIELDS = [
  'jwt',
  'token',
  'authorization',
  'secret',
  'seed',
  'privateKey',
  'secretKey',
  'kyc',
  'bankAccount',
  'iban',
  'nationalId',
] as const;

const DIRECTIONS = ['TRY_TO_USDC', 'USDC_TO_TRY'] as const;
type Direction = (typeof DIRECTIONS)[number];

interface RecordTransferBody {
  direction?: unknown;
  walletAddress?: unknown;
  anchorTransactionId?: unknown;
  stellarTxHash?: unknown;
  sourceAsset?: unknown;
  sourceAmount?: unknown;
  destinationAsset?: unknown;
  destinationAmount?: unknown;
  status?: unknown;
  quoteId?: unknown;
  payoutReference?: unknown;
}

/** Decimal string with at most 7 places — Stellar's precision. Never a float. */
const DECIMAL = /^\d{1,32}(\.\d{1,7})?$/;

@Controller('local-payments')
export class LocalPaymentsController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get()
  async list(@Query('wallet') wallet?: string, @Query('direction') direction?: string) {
    const rows = await this.prisma.anchorTransaction.findMany({
      where: {
        network: this.config.stellar.network,
        ...(wallet !== undefined ? { walletAddress: wallet } : {}),
        ...(direction !== undefined ? { direction: direction.toUpperCase() as never } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return {
      transfers: rows.map((row) => ({
        verification: 'self-reported',
        direction: row.direction,
        walletAddress: row.walletAddress,
        anchorTransactionId: row.anchorTransactionId,
        stellarTxHash: row.stellarTxHash,
        sourceAsset: row.sourceAsset,
        sourceAmount: row.sourceAmount?.toFixed(7) ?? null,
        destinationAsset: row.destinationAsset,
        destinationAmount: row.destinationAmount?.toFixed(7) ?? null,
        status: row.status,
        quoteId: row.quoteId,
        payoutReference: row.payoutReference,
        createdAt: row.createdAt.toISOString(),
      })),
      note: 'These are unverified client reports of Anchor transfers, not MilvanceCore contract events or completed-cycle proof.',
    };
  }

  /**
   * Record a completed local-payment leg.
   *
   * Off-chain metadata, so a write is legitimate — but it changes no financial
   * state: nothing here can fund a milestone, repay a funder or settle escrow.
   */
  @Post()
  async record(@Body() body: RecordTransferBody) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new BadRequestException('Transfer metadata must be a JSON object');
    }
    for (const field of FORBIDDEN_FIELDS) {
      if (field in (body as Record<string, unknown>)) {
        throw new BadRequestException(
          `Milvance never stores '${field}'. Remove it and resend; your Anchor session stays in your browser.`,
        );
      }
    }

    const direction = String(body.direction ?? '');
    if (!DIRECTIONS.includes(direction as Direction)) {
      throw new BadRequestException(`direction must be one of ${DIRECTIONS.join(', ')}`);
    }
    const walletAddress = String(body.walletAddress ?? '');
    if (!/^G[A-Z2-7]{55}$/.test(walletAddress)) {
      throw new BadRequestException('walletAddress must be a Stellar public key');
    }
    const status =
      typeof body.status === 'string' && /^[a-z_]{1,40}$/.test(body.status)
        ? body.status
        : 'unknown';

    const amount = (value: unknown, label: string): string | undefined => {
      if (value === undefined || value === null) {
        return undefined;
      }
      const text = String(value);
      if (!DECIMAL.test(text)) {
        throw new BadRequestException(`${label} must be a decimal amount, not a float literal`);
      }
      return text;
    };

    const anchorTransactionId =
      typeof body.anchorTransactionId === 'string' &&
      /^[a-zA-Z0-9._:-]{1,120}$/.test(body.anchorTransactionId)
        ? body.anchorTransactionId
        : null;
    if (anchorTransactionId === null) {
      throw new BadRequestException('anchorTransactionId is required for idempotent recording');
    }
    const stellarTxHash = typeof body.stellarTxHash === 'string' ? body.stellarTxHash : null;
    if (stellarTxHash !== null && !/^[0-9a-f]{64}$/i.test(stellarTxHash)) {
      throw new BadRequestException('stellarTxHash must be a 64-character hex transaction hash');
    }

    // Computed once so `exactOptionalPropertyTypes` can see the narrowing; a
    // repeated call would widen back to `string | undefined`.
    const sourceAmount = amount(body.sourceAmount, 'sourceAmount');
    const destinationAmount = amount(body.destinationAmount, 'destinationAmount');

    const data = {
      network: this.config.stellar.network,
      anchorDomain:
        this.config.stellar.network === 'testnet' ? 'tr-mock-anchor.fly.dev' : 'unknown',
      direction: direction as Direction,
      walletAddress,
      sourceAsset: direction === 'TRY_TO_USDC' ? 'iso4217:TRY' : 'USDC',
      destinationAsset: direction === 'TRY_TO_USDC' ? 'USDC' : 'iso4217:TRY',
      status,
      anchorTransactionId,
      ...(stellarTxHash !== null ? { stellarTxHash } : {}),
      ...(sourceAmount !== undefined ? { sourceAmount } : {}),
      ...(destinationAmount !== undefined ? { destinationAmount } : {}),
      ...(typeof body.quoteId === 'string' && /^[a-zA-Z0-9._:-]{1,120}$/.test(body.quoteId)
        ? { quoteId: body.quoteId }
        : {}),
    };

    const row = await this.prisma.anchorTransaction.upsert({
      where: {
        anchor_transfer_identity: {
          network: data.network,
          anchorDomain: data.anchorDomain,
          anchorTransactionId,
        },
      },
      create: data,
      update: { status, ...(stellarTxHash !== null ? { stellarTxHash } : {}) },
    });

    return {
      recorded: true,
      verification: 'self-reported',
      id: row.id,
      direction: row.direction,
      status: row.status,
    };
  }
}

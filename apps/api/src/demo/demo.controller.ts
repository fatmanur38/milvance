import { BadRequestException, Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';

import type { ApiConfig } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { API_CONFIG } from '../tokens';

/**
 * Consent-based participation metadata for Trade Lab (AGENT.md §PKG-10).
 *
 * This records one thing the chain cannot: whether a person who used Milvance
 * at an event is happy to be counted, and whether they are on the team. It is
 * deliberately tiny and deliberately not financial — it cannot create a trade,
 * move USDC, change a status or make anything appear in the workspace.
 *
 * What is NOT stored, and is refused by name if sent: any token, seed, key, KYC
 * payload or bank detail. A wallet address is a public key and is already
 * visible on every transaction that wallet signs.
 *
 * Counting is PKG-11's job. A row here is consent, not evidence of usage: a
 * public traction number must still come from indexed contract events.
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
  'email',
  'phone',
  'name',
] as const;

/** Where a participant came from. A short allowlist, never free text. */
const SOURCES = ['trade-lab', 'invite', 'workspace'] as const;
type Source = (typeof SOURCES)[number];

interface ParticipantBody {
  walletAddress?: unknown;
  consentToCount?: unknown;
  isTeam?: unknown;
  source?: unknown;
}

@Controller('demo/participants')
export class DemoController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  /**
   * This wallet's own consent state.
   *
   * Public-safe and minimal: an address, two booleans and when it was first
   * seen. No aggregate, no list of everyone — one wallet at a time, so this
   * endpoint cannot become a directory of event attendees.
   */
  @Get(':address')
  async show(@Param('address') address: string) {
    const walletAddress = this.parseAddress(address);
    const row = await this.prisma.demoParticipant.findUnique({
      where: {
        participant_identity: { network: this.config.stellar.network, walletAddress },
      },
    });
    if (row === null) {
      return { walletAddress, known: false, consentToCount: false, isTeam: false };
    }
    return {
      walletAddress: row.walletAddress,
      known: true,
      consentToCount: row.consentToCount,
      isTeam: row.isTeam,
      source: row.source,
      firstSeenAt: row.firstSeenAt.toISOString(),
    };
  }

  /**
   * Record or update consent.
   *
   * `isTeam` is one-way: a wallet may declare itself part of the team, which
   * only ever excludes it from external counts, but this endpoint can never
   * clear the flag. Nobody can quietly promote themselves into the external
   * traction numbers, and an operator's team marking cannot be undone from a
   * browser.
   */
  @Post()
  async record(@Body() body: ParticipantBody) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new BadRequestException('Participant metadata must be a JSON object');
    }
    for (const field of FORBIDDEN_FIELDS) {
      if (field in (body as Record<string, unknown>)) {
        throw new BadRequestException(
          `Milvance never stores '${field}'. Remove it and resend: this record is a wallet address and a consent flag, nothing else.`,
        );
      }
    }

    const walletAddress = this.parseAddress(String(body.walletAddress ?? ''));
    if (typeof body.consentToCount !== 'boolean') {
      throw new BadRequestException('consentToCount must be true or false');
    }
    if (body.isTeam !== undefined && typeof body.isTeam !== 'boolean') {
      throw new BadRequestException('isTeam must be true or false');
    }
    const source = body.source === undefined ? 'trade-lab' : String(body.source);
    if (!SOURCES.includes(source as Source)) {
      throw new BadRequestException(`source must be one of ${SOURCES.join(', ')}`);
    }

    const network = this.config.stellar.network;
    const identity = { participant_identity: { network, walletAddress } };
    const existing = await this.prisma.demoParticipant.findUnique({ where: identity });
    // One-way: true can be set, never unset.
    const isTeam = existing?.isTeam === true || body.isTeam === true;

    const row = await this.prisma.demoParticipant.upsert({
      where: identity,
      create: {
        network,
        walletAddress,
        consentToCount: body.consentToCount,
        isTeam,
        source,
      },
      update: { consentToCount: body.consentToCount, isTeam, source },
    });

    return {
      walletAddress: row.walletAddress,
      consentToCount: row.consentToCount,
      isTeam: row.isTeam,
      source: row.source,
      note: 'Consent only. Public traction still has to come from indexed contract events.',
    };
  }

  /** Exact comparison, never case-folded: addresses are identities. */
  private parseAddress(raw: string): string {
    if (!/^G[A-Z2-7]{55}$/.test(raw)) {
      throw new BadRequestException('walletAddress must be a Stellar public key');
    }
    return raw;
  }
}

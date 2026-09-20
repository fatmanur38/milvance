import type { PrismaClient } from '../generated/prisma/client';
import { decodeEvent } from '../indexer/decoder';
import { ADDRESSES, CONTRACT_ID, NETWORK, rawEvent } from '../indexer/fixtures.test-helper';
import { projectEvent } from '../indexer/projector';

/**
 * The live Testnet history, replayed through the real projector.
 *
 * Deliberately mirrors what MilvanceCore actually emitted during the PKG-09
 * proof — two orders, one financed milestone that settled, one disputed
 * milestone that refunded, and a third order created and left open — so the
 * metric tests assert against a shape the product has really produced rather
 * than one invented to make the arithmetic convenient.
 *
 * Amounts are in USDC base units: 10 USDC is 100_000_000.
 */
export const SCOPE = { network: NETWORK, contractId: CONTRACT_ID } as const;

export const LIVE = {
  milestoneOneAmount: 20_000_000_000n, // 200 USDC, never funded
  protectedEach: 100_000_000n, // 10 USDC
  principal: 80_000_000n, // 8 USDC advance
  repayment: 90_000_000n, // 9 USDC owed back
  supplierPayout: 10_000_000n, // 1 USDC residual
} as const;

async function apply(
  prisma: PrismaClient,
  name: string,
  fields: Record<string, unknown>,
): Promise<void> {
  await projectEvent(prisma, SCOPE, decodeEvent(rawEvent(name, fields)));
}

/** Replays the whole live history. Safe to call twice — see the replay test. */
export async function seedLiveHistory(prisma: PrismaClient): Promise<void> {
  const parties = {
    buyer: ADDRESSES.buyer,
    supplier: ADDRESSES.supplier,
    attestor: ADDRESSES.attestor,
    resolver: ADDRESSES.resolver,
    asset: ADDRESSES.usdcSac,
  };

  await apply(prisma, 'order_created', { order_id: 1n, ...parties });
  await apply(prisma, 'order_created', { order_id: 2n, ...parties });
  await apply(prisma, 'milestone_created', {
    order_id: 1n,
    milestone_id: 1n,
    index: 0,
    amount: LIVE.milestoneOneAmount,
    deadline: 1_790_369_999n,
  });
  await apply(prisma, 'milestone_created', {
    order_id: 2n,
    milestone_id: 2n,
    index: 0,
    amount: LIVE.protectedEach,
    deadline: null,
  });
  await apply(prisma, 'milestone_created', {
    order_id: 2n,
    milestone_id: 3n,
    index: 1,
    amount: LIVE.protectedEach,
    deadline: null,
  });
  await apply(prisma, 'order_accepted', { order_id: 2n, supplier: ADDRESSES.supplier });

  // Milestone 2: protected, financed, verified, settled.
  await apply(prisma, 'milestone_funded', {
    order_id: 2n,
    milestone_id: 2n,
    buyer: ADDRESSES.buyer,
    amount: LIVE.protectedEach,
    funded_amount: LIVE.protectedEach,
    fully_funded: true,
  });
  await apply(prisma, 'finance_requested', {
    milestone_id: 2n,
    supplier: ADDRESSES.supplier,
    requested_principal: LIVE.principal,
    protected_amount: LIVE.protectedEach,
    expires_at: 1_791_068_173n,
  });
  await apply(prisma, 'funding_offer_created', {
    milestone_id: 2n,
    offer_id: 1n,
    funder: ADDRESSES.funder,
    principal: LIVE.principal,
    repayment: LIVE.repayment,
    expires_at: 1_790_118_611n,
  });
  await apply(prisma, 'offer_accepted', {
    milestone_id: 2n,
    offer_id: 1n,
    funder: ADDRESSES.funder,
    principal: LIVE.principal,
    repayment: LIVE.repayment,
  });
  await apply(prisma, 'advance_funded', {
    milestone_id: 2n,
    offer_id: 1n,
    funder: ADDRESSES.funder,
    supplier: ADDRESSES.supplier,
    principal: LIVE.principal,
    repayment: LIVE.repayment,
    protected_amount: LIVE.protectedEach,
  });
  await apply(prisma, 'evidence_submitted', {
    milestone_id: 2n,
    supplier: ADDRESSES.supplier,
    evidence_hash: '7'.repeat(64),
    replaced_previous: false,
  });
  await apply(prisma, 'milestone_verified', {
    milestone_id: 2n,
    attestor: ADDRESSES.attestor,
    evidence_hash: '7'.repeat(64),
  });
  await apply(prisma, 'milestone_settled', {
    order_id: 2n,
    milestone_id: 2n,
    protected_amount: LIVE.protectedEach,
    funder_repayment: LIVE.repayment,
    supplier_payout: LIVE.supplierPayout,
  });

  // Milestone 3: protected, disputed, refunded — never financed.
  await apply(prisma, 'milestone_funded', {
    order_id: 2n,
    milestone_id: 3n,
    buyer: ADDRESSES.buyer,
    amount: LIVE.protectedEach,
    funded_amount: LIVE.protectedEach,
    fully_funded: true,
  });
  await apply(prisma, 'dispute_opened', {
    milestone_id: 3n,
    dispute_id: 1n,
    opened_by: ADDRESSES.buyer,
    resolver: ADDRESSES.resolver,
  });
  await apply(prisma, 'milestone_refunded', {
    order_id: 2n,
    milestone_id: 3n,
    buyer: ADDRESSES.buyer,
    refunded_amount: LIVE.protectedEach,
    funder_advance_outstanding: 0n,
  });
  await apply(prisma, 'dispute_resolved', {
    milestone_id: 3n,
    dispute_id: 1n,
    resolver: ADDRESSES.resolver,
    settled: false,
  });
  await apply(prisma, 'order_completed', { order_id: 2n });

  // Order 3: created by the PKG-10 Trade Lab proof, still open.
  await apply(prisma, 'order_created', { order_id: 3n, ...parties });
}

/** A completed Anchor report, unverified until something checks Stellar. */
export function anchorReport(
  overrides: Partial<{
    direction: 'TRY_TO_USDC' | 'USDC_TO_TRY';
    walletAddress: string;
    anchorTransactionId: string;
    stellarTxHash: string;
    sourceAmount: string;
    destinationAmount: string;
    status: string;
  }> = {},
) {
  const direction = overrides.direction ?? 'TRY_TO_USDC';
  return {
    network: NETWORK,
    anchorDomain: 'tr-mock-anchor.fly.dev',
    direction,
    walletAddress: overrides.walletAddress ?? ADDRESSES.buyer,
    anchorTransactionId:
      overrides.anchorTransactionId ?? `sep_${Math.random().toString(36).slice(2)}`,
    stellarTxHash: overrides.stellarTxHash ?? 'a'.repeat(64),
    sourceAsset: direction === 'TRY_TO_USDC' ? 'iso4217:TRY' : 'USDC',
    destinationAsset: direction === 'TRY_TO_USDC' ? 'USDC' : 'iso4217:TRY',
    sourceAmount:
      overrides.sourceAmount ?? (direction === 'TRY_TO_USDC' ? '1000.0000000' : '5.0000000'),
    destinationAmount:
      overrides.destinationAmount ?? (direction === 'TRY_TO_USDC' ? '20.3960908' : '245.0000000'),
    status: overrides.status ?? 'completed',
  };
}

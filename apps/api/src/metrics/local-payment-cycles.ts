import type { Prisma, PrismaClient, StellarLegStatus } from '../generated/prisma/client';
import type { StellarConfig } from '../config';

/**
 * Completed local-payment finance cycles: the north-star metric, and the only
 * metric here that spans two worlds.
 *
 * Everything else Milvance publishes is either a contract event or an admitted
 * report. This one joins them, which is exactly where a traction number is
 * easiest to fake — so the join is deliberately narrow:
 *
 *   1. The chain legs are read from projections of MilvanceCore events. A
 *      milestone must have been protected by the buyer, advanced by a real
 *      funder, and settled by the contract.
 *   2. The local-money leg must be a report whose STELLAR side Stellar itself
 *      confirms: the approved USDC asset, the right direction, the reported
 *      wallet, the reported amount. A report on its own never counts.
 *   3. The link between them is wallet identity plus ordering in time. It is
 *      NOT a claim that the same units flowed through, because USDC is fungible
 *      and no such claim would be true.
 *
 * The fiat side is never verified, because no blockchain can verify a bank
 * transfer. It stays labelled as the Anchor's word throughout.
 */

/** A Horizon payment operation, narrowed to what we check. */
interface HorizonOperation {
  readonly type?: unknown;
  readonly from?: unknown;
  readonly to?: unknown;
  readonly amount?: unknown;
  readonly asset_code?: unknown;
  readonly asset_issuer?: unknown;
}

export interface LegVerdict {
  readonly status: StellarLegStatus;
  /** Public-safe explanation. Never a credential, never a bank detail. */
  readonly detail: string;
  /** Ledger close time of the confirmed payment. */
  readonly at: Date | null;
}

export interface ReportedLeg {
  readonly direction: 'TRY_TO_USDC' | 'USDC_TO_TRY';
  readonly walletAddress: string;
  readonly stellarTxHash: string | null;
  /** USDC the wallet received, for an on-ramp. */
  readonly destinationAmount: string | null;
  /** USDC the wallet sent, for an off-ramp. */
  readonly sourceAmount: string | null;
}

const HASH = /^[0-9a-f]{64}$/;

/**
 * Checks one reported leg against Stellar.
 *
 * `fetchJson` is injected so the decision logic can be tested exhaustively
 * without a network, and so a Horizon outage is a caller's problem rather than
 * a hidden dependency of the metric.
 */
export async function verifyStellarLeg(
  leg: ReportedLeg,
  stellar: Pick<StellarConfig, 'horizonUrl' | 'usdcIssuer'>,
  fetchJson: (url: string) => Promise<unknown>,
): Promise<LegVerdict> {
  const hash = leg.stellarTxHash;
  if (hash === null || !HASH.test(hash)) {
    return {
      status: 'UNVERIFIABLE',
      detail: 'No Stellar transaction hash was reported, so there is nothing to check.',
      at: null,
    };
  }

  const expectedUsdc = leg.direction === 'TRY_TO_USDC' ? leg.destinationAmount : leg.sourceAmount;
  if (expectedUsdc === null) {
    return {
      status: 'UNVERIFIABLE',
      detail: 'The report records no USDC amount, so there is nothing to match against Stellar.',
      at: null,
    };
  }

  let transaction: { successful?: unknown; created_at?: unknown };
  try {
    transaction = (await fetchJson(
      `${stellar.horizonUrl.replace(/\/$/, '')}/transactions/${hash}`,
    )) as typeof transaction;
  } catch {
    return {
      status: 'UNVERIFIABLE',
      detail: 'Stellar has no record of the reported transaction hash.',
      at: null,
    };
  }
  if (transaction.successful !== true) {
    return {
      status: 'MISMATCHED',
      detail: 'The reported transaction exists on Stellar but did not succeed.',
      at: null,
    };
  }

  let operations: { _embedded?: { records?: unknown } };
  try {
    operations = (await fetchJson(
      `${stellar.horizonUrl.replace(/\/$/, '')}/transactions/${hash}/operations?limit=200`,
    )) as typeof operations;
  } catch {
    return {
      status: 'UNVERIFIABLE',
      detail: 'Stellar returned no operations for the reported transaction.',
      at: null,
    };
  }

  const records = Array.isArray(operations._embedded?.records)
    ? (operations._embedded.records as HorizonOperation[])
    : [];
  const payments = records.filter(
    (op) =>
      op.type === 'payment' && op.asset_code === 'USDC' && op.asset_issuer === stellar.usdcIssuer,
  );
  if (payments.length === 0) {
    return {
      status: 'MISMATCHED',
      detail: 'The reported transaction moves no payment of the approved USDC asset.',
      at: null,
    };
  }

  // On-ramp: local money became USDC, so the wallet must RECEIVE it.
  // Off-ramp: USDC became local money, so the wallet must SEND it.
  const counterparty = leg.direction === 'TRY_TO_USDC' ? 'to' : 'from';
  const matching = payments.filter((op) => op[counterparty] === leg.walletAddress);
  if (matching.length === 0) {
    return {
      status: 'MISMATCHED',
      detail:
        leg.direction === 'TRY_TO_USDC'
          ? 'The reported transaction pays USDC to a different wallet than the one that reported it.'
          : 'The reported transaction sends USDC from a different wallet than the one that reported it.',
      at: null,
    };
  }

  const exact = matching.find((op) => String(op.amount) === expectedUsdc);
  if (exact === undefined) {
    return {
      status: 'MISMATCHED',
      detail: `Stellar records a different USDC amount than the reported ${expectedUsdc}.`,
      at: null,
    };
  }

  const at = typeof transaction.created_at === 'string' ? new Date(transaction.created_at) : null;
  return {
    status: 'CONFIRMED',
    detail: `Stellar confirms ${expectedUsdc} USDC ${
      leg.direction === 'TRY_TO_USDC' ? 'paid to' : 'sent by'
    } this wallet in the reported transaction.`,
    at,
  };
}

/** How a confirmed local-payment leg attaches to a financed milestone. */
export type CycleLink = 'supplier-offramp' | 'buyer-onramp';

export interface CycleRow {
  readonly milestoneId: bigint;
  /** Null until the milestone settles; a cycle needs a settlement to count. */
  readonly orderId: bigint | null;
  readonly verified: boolean;
  readonly link: CycleLink | null;
  /** Public Stellar hash of the confirmed leg, so a judge can look it up. */
  readonly legTxHash: string | null;
  /** Why an otherwise-complete cycle does not count. */
  readonly missing: readonly string[];
}

type Client = PrismaClient | Prisma.TransactionClient;

/**
 * Recomputes every cycle from the database. No network, no cached judgement.
 *
 * Deliberately pure DB work: the Stellar verdicts were reached and stored by
 * `verifyReportedLegs`, so this can run on every request and after every replay
 * and reach the same answer. An unverified leg simply never supports a cycle,
 * which makes the failure mode "counts nothing" rather than "counts wrongly".
 */
export async function deriveCycles(
  prisma: Client,
  scope: { network: string; contractId: string },
): Promise<readonly CycleRow[]> {
  const [positions, settlements, orders, confirmedLegs] = await Promise.all([
    prisma.financePositionReadModel.findMany({ where: scope }),
    prisma.settlementReadModel.findMany({ where: scope }),
    prisma.orderReadModel.findMany({
      where: scope,
      select: { orderId: true, buyer: true, supplier: true },
    }),
    prisma.anchorTransaction.findMany({
      where: { network: scope.network, stellarLegStatus: 'CONFIRMED' },
      select: {
        direction: true,
        walletAddress: true,
        stellarTxHash: true,
        stellarLegAt: true,
      },
    }),
  ]);

  const settlementFor = new Map(settlements.map((row) => [row.milestoneId, row]));
  const buyerOf = new Map(orders.map((row) => [row.orderId, row.buyer]));

  const cycles: CycleRow[] = [];
  // One row per financed milestone: an advance is what makes a cycle possible.
  const seen = new Set<bigint>();
  for (const position of positions) {
    if (seen.has(position.milestoneId)) continue;
    seen.add(position.milestoneId);

    const settlement = settlementFor.get(position.milestoneId);
    const missing: string[] = [];
    if (settlement === undefined) {
      missing.push('the milestone has not settled on chain');
    }

    // The supplier off-ramp is the canonical leg: the advance became local
    // money the supplier could actually spend on production.
    const offRamp = confirmedLegs.find(
      (leg) =>
        leg.direction === 'USDC_TO_TRY' &&
        leg.walletAddress === position.supplier &&
        leg.stellarLegAt !== null &&
        leg.stellarLegAt >= position.fundedAt,
    );
    // The buyer on-ramp closes the same loop at the other end: local capital
    // entered the wallet that then protected this milestone. Only reachable
    // once the milestone settled, which is also where the ordering bound comes
    // from — the buyer's wallet is only known through the settled order.
    const buyerAddress = settlement === undefined ? undefined : buyerOf.get(settlement.orderId);
    const onRamp =
      offRamp !== undefined || settlement === undefined || buyerAddress === undefined
        ? undefined
        : confirmedLegs.find(
            (leg) =>
              leg.direction === 'TRY_TO_USDC' &&
              leg.walletAddress === buyerAddress &&
              leg.stellarLegAt !== null &&
              leg.stellarLegAt <= settlement.settledAt,
          );

    const leg = offRamp ?? onRamp;
    if (leg === undefined) {
      missing.push('no local-money conversion is confirmed on Stellar for a party to this trade');
    }

    const verified = missing.length === 0;
    cycles.push({
      milestoneId: position.milestoneId,
      orderId: settlement?.orderId ?? null,
      verified,
      link: verified ? (offRamp !== undefined ? 'supplier-offramp' : 'buyer-onramp') : null,
      legTxHash: verified ? (leg?.stellarTxHash ?? null) : null,
      missing,
    });
  }
  return cycles;
}

/**
 * Materialises the derived cycles so they can be inspected outside a request.
 *
 * Idempotent by construction: keyed on the cycle identity, so running it twice,
 * or after a replay, converges on the same rows rather than accumulating them.
 */
export async function storeCycles(
  prisma: Client,
  scope: { network: string; contractId: string },
  cycles: readonly CycleRow[],
): Promise<void> {
  const milestones = await prisma.milestoneReadModel.findMany({
    where: { ...scope, milestoneId: { in: cycles.map((cycle) => cycle.milestoneId) } },
    select: { id: true, milestoneId: true },
  });
  const rowIdFor = new Map(milestones.map((row) => [row.milestoneId, row.id]));

  for (const cycle of cycles) {
    const milestoneRowId = rowIdFor.get(cycle.milestoneId);
    if (milestoneRowId === undefined) continue;
    const data = {
      status: cycle.verified ? ('VERIFIED' as const) : ('CANDIDATE' as const),
      anchorTransactionId: cycle.legTxHash,
      verifiedAt: cycle.verified ? new Date() : null,
    };
    await prisma.localPaymentCycleReadModel.upsert({
      where: { cycle_identity: { ...scope, milestoneId: cycle.milestoneId } },
      create: { ...scope, milestoneId: cycle.milestoneId, milestoneRowId, ...data },
      update: data,
    });
  }
}

/**
 * Checks every reported leg that has not been checked yet, against Stellar.
 *
 * Separated from the read path on purpose. It talks to Horizon, so it is an
 * explicit operation with an audit trail in the row, not something a page load
 * triggers — and a verdict, once reached, survives an indexer replay because
 * the Anchor report is off-chain metadata the replay does not touch.
 */
export async function verifyReportedLegs(
  prisma: PrismaClient,
  stellar: Pick<StellarConfig, 'horizonUrl' | 'usdcIssuer' | 'network'>,
  fetchJson: (url: string) => Promise<unknown>,
  options: { recheckAll?: boolean } = {},
): Promise<{ checked: number; confirmed: number; mismatched: number; unverifiable: number }> {
  const rows = await prisma.anchorTransaction.findMany({
    where: {
      network: stellar.network,
      ...(options.recheckAll === true ? {} : { stellarLegStatus: 'UNCHECKED' as const }),
    },
  });

  const tally = { checked: 0, confirmed: 0, mismatched: 0, unverifiable: 0 };
  for (const row of rows) {
    const verdict = await verifyStellarLeg(
      {
        direction: row.direction,
        walletAddress: row.walletAddress,
        stellarTxHash: row.stellarTxHash,
        destinationAmount: row.destinationAmount?.toFixed(7) ?? null,
        sourceAmount: row.sourceAmount?.toFixed(7) ?? null,
      },
      stellar,
      fetchJson,
    );
    await prisma.anchorTransaction.update({
      where: { id: row.id },
      data: {
        stellarLegStatus: verdict.status,
        stellarLegDetail: verdict.detail,
        stellarLegCheckedAt: new Date(),
        stellarLegAt: verdict.at,
      },
    });
    tally.checked += 1;
    if (verdict.status === 'CONFIRMED') tally.confirmed += 1;
    if (verdict.status === 'MISMATCHED') tally.mismatched += 1;
    if (verdict.status === 'UNVERIFIABLE') tally.unverifiable += 1;
  }
  return tally;
}

import type { Prisma, PrismaClient } from '../generated/prisma/client';
import { deriveCycles, type CycleRow } from './local-payment-cycles';

/**
 * Computes every public metric from the database.
 *
 * Money rules, which are the whole reason this file is not a handful of
 * `_count` calls:
 *
 *   - USDC is aggregated as `bigint` in base units. No JavaScript number ever
 *     touches an authoritative figure, so nothing can be off by a cent because
 *     of binary floating point.
 *   - TRY is aggregated as Prisma `Decimal`, which is exact decimal arithmetic,
 *     and rendered at the recorded precision rather than rounded to look tidy.
 *   - Formatting happens in the browser. This module emits base units and
 *     decimal strings, never display text.
 *
 * Nothing here reads a form, a session or a click. Every chain figure comes
 * from a projection of MilvanceCore events.
 */

type Client = PrismaClient | Prisma.TransactionClient;

export interface Scope {
  readonly network: string;
  readonly contractId: string;
}

/** Sums exact integer base units. Never `reduce((a, b) => a + Number(b))`. */
function sumBase(values: readonly Prisma.Decimal[]): bigint {
  let total = 0n;
  for (const value of values) total += BigInt(value.toFixed(0));
  return total;
}

/**
 * A fixed-point decimal as exact base units.
 *
 * TRY is stored with 7 decimal places, so 12.50 becomes 125_000_000 and every
 * later addition is integer arithmetic. Parsing through the decimal string
 * keeps the recorded precision instead of rounding it to look tidy.
 */
function toBaseUnits(value: Prisma.Decimal, places: number): bigint {
  const [whole, fraction = ''] = value.toFixed(places).split('.');
  return BigInt(`${whole}${fraction}`);
}

/** Renders exact base units back to a decimal string. Presentation boundary. */
function fromBaseUnits(total: bigint, places: number): string {
  const negative = total < 0n;
  const digits = (negative ? -total : total).toString().padStart(places + 1, '0');
  const whole = digits.slice(0, digits.length - places);
  const fraction = digits.slice(digits.length - places);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : // Averaging two whole seconds can only produce a half, so rounding here
      // loses nothing a caller could have used.
      Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

/** Decimal places the local-currency columns are recorded with. */
const FIAT_DECIMALS = 7;

const PROTECTED_STATES = [
  'FUNDED',
  'FINANCE_REQUESTED',
  'FINANCED',
  'SUBMITTED',
  'VERIFIED',
  'DISPUTED',
  'SETTLED',
  'REFUNDED',
] as const;

export interface PublicMetrics {
  readonly protocolActivity: Record<string, string | number>;
  readonly localPayments: Record<string, string | number>;
  readonly northStar: {
    readonly completedLocalPaymentFinanceCycles: number;
    readonly candidateCycles: number;
    readonly supplierOffRampCycles: number;
    readonly buyerOnRampCycles: number;
    readonly cycles: readonly {
      readonly milestoneId: string;
      readonly orderId: string | null;
      readonly counted: boolean;
      readonly link: string | null;
      readonly localPaymentTxHash: string | null;
      readonly missing: readonly string[];
    }[];
  };
  readonly adoption: {
    readonly externalWallets: number;
    readonly teamWallets: number;
    readonly unclassifiedWallets: number;
    readonly distinctWallets: number;
  };
  readonly timings: {
    readonly medianOrderCompletionSeconds: number | null;
    readonly medianTimeToLocalCashSeconds: number | null;
  };
}

export async function computePublicMetrics(prisma: Client, scope: Scope): Promise<PublicMetrics> {
  const [
    orders,
    milestones,
    settlements,
    refunds,
    positions,
    requests,
    offers,
    disputes,
    anchors,
    cycles,
  ] = await Promise.all([
    prisma.orderReadModel.findMany({
      where: scope,
      select: {
        orderId: true,
        status: true,
        buyer: true,
        supplier: true,
        attestor: true,
        resolver: true,
        createdAt: true,
      },
    }),
    prisma.milestoneReadModel.findMany({
      where: scope,
      select: { milestoneId: true, status: true, fundedAmount: true },
    }),
    prisma.settlementReadModel.findMany({ where: scope }),
    prisma.refundReadModel.findMany({ where: scope }),
    prisma.financePositionReadModel.findMany({ where: scope }),
    prisma.financeRequestReadModel.count({ where: scope }),
    prisma.fundingOfferReadModel.findMany({ where: scope, select: { funder: true } }),
    prisma.disputeReadModel.count({ where: scope }),
    prisma.anchorTransaction.findMany({ where: { network: scope.network } }),
    deriveCycles(prisma, scope),
  ]);

  // --- Buyer escrow ----------------------------------------------------------
  // Settlement and refund zero a milestone's escrow, so summing the live column
  // alone would quietly forget every completed trade. The three sets below are
  // disjoint — a milestone is settled, refunded, or still holding — so adding
  // them is exact and double-counts nothing.
  const stillHeld = milestones.filter(
    (row) => row.status !== 'SETTLED' && row.status !== 'REFUNDED',
  );
  const protectedVolume =
    sumBase(settlements.map((row) => row.protectedAmount)) +
    sumBase(refunds.map((row) => row.refundedAmount)) +
    sumBase(stillHeld.map((row) => row.fundedAmount));

  const protectedStates = new Set<string>(PROTECTED_STATES);
  const completedOrders = orders.filter((order) => order.status === 'COMPLETED');

  // --- Wallets ---------------------------------------------------------------
  // Only wallets that appear in chain state. A wallet that merely connected to
  // the app is not here: a connection is a click, not participation.
  const wallets = new Set<string>();
  for (const order of orders) {
    wallets.add(order.buyer);
    wallets.add(order.supplier);
    wallets.add(order.attestor);
    wallets.add(order.resolver);
  }
  for (const offer of offers) wallets.add(offer.funder);
  for (const position of positions) wallets.add(position.funder);

  const tags =
    wallets.size === 0
      ? []
      : await prisma.demoParticipant.findMany({
          where: { network: scope.network, walletAddress: { in: [...wallets] } },
          select: { walletAddress: true, isTeam: true, consentToCount: true },
        });
  const tagFor = new Map(tags.map((row) => [row.walletAddress, row]));
  let externalWallets = 0;
  let teamWallets = 0;
  for (const wallet of wallets) {
    const tag = tagFor.get(wallet);
    if (tag === undefined) continue;
    // Team is checked first and wins. Someone who declared themselves team can
    // never also be counted as outside adoption, whatever else the row says.
    if (tag.isTeam) teamWallets += 1;
    else if (tag.consentToCount) externalWallets += 1;
  }

  // --- Local payments --------------------------------------------------------
  const completedAnchors = anchors.filter((row) => row.status === 'completed');
  const onRamps = completedAnchors.filter((row) => row.direction === 'TRY_TO_USDC');
  const offRamps = completedAnchors.filter((row) => row.direction === 'USDC_TO_TRY');
  const sumTry = (
    rows: readonly {
      sourceAmount: Prisma.Decimal | null;
      destinationAmount: Prisma.Decimal | null;
    }[],
    field: 'sourceAmount' | 'destinationAmount',
  ): string => {
    let total = 0n;
    for (const row of rows) {
      const value = row[field];
      if (value !== null) total += toBaseUnits(value, FIAT_DECIMALS);
    }
    return fromBaseUnits(total, FIAT_DECIMALS);
  };

  // --- Timings ---------------------------------------------------------------
  const terminalAt = new Map<bigint, Date>();
  for (const row of settlements) keepLatest(terminalAt, row.orderId, row.settledAt);
  for (const row of refunds) keepLatest(terminalAt, row.orderId, row.refundedAt);
  const completionSeconds = completedOrders
    .map((order) => {
      const finished = terminalAt.get(order.orderId);
      return finished === undefined
        ? null
        : Math.round((finished.getTime() - order.createdAt.getTime()) / 1000);
    })
    .filter((value): value is number => value !== null && value >= 0);

  const confirmedOffRamps = offRamps.filter(
    (row) => row.stellarLegStatus === 'CONFIRMED' && row.stellarLegAt !== null,
  );
  const timeToCash: number[] = [];
  for (const position of positions) {
    const leg = confirmedOffRamps.find(
      (row) => row.walletAddress === position.supplier && row.stellarLegAt! >= position.fundedAt,
    );
    if (leg !== undefined) {
      timeToCash.push(
        Math.round((leg.stellarLegAt!.getTime() - position.fundedAt.getTime()) / 1000),
      );
    }
  }

  const counted = cycles.filter((cycle) => cycle.verified);
  return {
    protocolActivity: {
      ordersCreated: orders.length,
      ordersAccepted: orders.filter(
        (order) => order.status === 'ACTIVE' || order.status === 'COMPLETED',
      ).length,
      ordersCompleted: completedOrders.length,
      milestonesCreated: milestones.length,
      milestonesProtected: milestones.filter((row) => protectedStates.has(row.status)).length,
      protectedVolume: protectedVolume.toString(),
      financeRequests: requests,
      fundingOffers: offers.length,
      advancesFunded: positions.length,
      advanceVolume: sumBase(positions.map((row) => row.principal)).toString(),
      milestonesSettled: settlements.length,
      funderRepaymentVolume: sumBase(settlements.map((row) => row.funderRepayment)).toString(),
      supplierResidualVolume: sumBase(settlements.map((row) => row.supplierPayout)).toString(),
      disputesOpened: disputes,
      milestonesRefunded: refunds.length,
      refundVolume: sumBase(refunds.map((row) => row.refundedAmount)).toString(),
      distinctWallets: wallets.size,
    },
    localPayments: {
      onRampsReported: onRamps.length,
      offRampsReported: offRamps.length,
      legsChainConfirmed: completedAnchors.filter((row) => row.stellarLegStatus === 'CONFIRMED')
        .length,
      legsMismatched: completedAnchors.filter((row) => row.stellarLegStatus === 'MISMATCHED')
        .length,
      legsUnchecked: completedAnchors.filter((row) => row.stellarLegStatus === 'UNCHECKED').length,
      tryOnboarded: sumTry(onRamps, 'sourceAmount'),
      tryPaidToSuppliers: sumTry(offRamps, 'destinationAmount'),
    },
    northStar: {
      completedLocalPaymentFinanceCycles: counted.length,
      candidateCycles: cycles.length,
      supplierOffRampCycles: counted.filter((cycle) => cycle.link === 'supplier-offramp').length,
      buyerOnRampCycles: counted.filter((cycle) => cycle.link === 'buyer-onramp').length,
      cycles: cycles.map(publicCycle),
    },
    adoption: {
      externalWallets,
      teamWallets,
      unclassifiedWallets: wallets.size - externalWallets - teamWallets,
      distinctWallets: wallets.size,
    },
    timings: {
      medianOrderCompletionSeconds: median(completionSeconds),
      medianTimeToLocalCashSeconds: median(timeToCash),
    },
  };
}

/**
 * What a cycle looks like in public.
 *
 * Milestone and order ids and a Stellar transaction hash are already public on
 * chain and are what makes a number checkable. Wallet addresses are left out:
 * a traction page has no business being a directory of who did what.
 */
function publicCycle(cycle: CycleRow) {
  return {
    milestoneId: cycle.milestoneId.toString(),
    orderId: cycle.orderId?.toString() ?? null,
    counted: cycle.verified,
    link: cycle.link,
    localPaymentTxHash: cycle.legTxHash,
    missing: cycle.missing,
  };
}

function keepLatest(into: Map<bigint, Date>, key: bigint, at: Date): void {
  const current = into.get(key);
  if (current === undefined || at > current) into.set(key, at);
}

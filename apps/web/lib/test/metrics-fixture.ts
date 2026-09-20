import type { MetricDefinition, PublicMetrics } from '../api/schemas';

/**
 * A metrics payload in the API's exact shape.
 *
 * Values mirror the real live Testnet state at the end of PKG-10: three orders,
 * one financed milestone settled, one refunded, one Anchor report, and nobody
 * classified as an external participant.
 */
function definition(overrides: Partial<MetricDefinition> & { key: string }): MetricDefinition {
  return {
    label: overrides.key,
    definition: 'A definition.',
    source: 'A source.',
    excludes: 'Nothing.',
    unit: 'count',
    provenance: 'on-chain',
    population: 'all-participants',
    ...overrides,
  };
}

export function metricsFixture(overrides: Partial<PublicMetrics> = {}): PublicMetrics {
  const base: PublicMetrics = {
    scope: {
      network: 'testnet',
      contractId: 'CCN6AZHLN2BQPCDZWXJGA3NRJEJ56V5JK3M4VZ5QFKQ3NSJBN6RVTKRX',
      testnetOnly: true,
      usdcDecimals: 7,
      note: 'Milvance runs on Stellar Testnet with test USDC.',
      ...overrides.scope,
    },
    provenance: {
      chainMetrics: 'Projected from MilvanceCore events.',
      localPaymentMetrics:
        'Reported by the Anchor flow; the fiat side cannot be proven by any blockchain.',
      adoptionMetrics: 'Wallet owners classify themselves.',
      indexedThroughLedger: '4769467',
      indexedEvents: 20,
      ...overrides.provenance,
    },
    protocolActivity: {
      ordersCreated: 3,
      ordersAccepted: 1,
      ordersCompleted: 1,
      milestonesCreated: 3,
      milestonesProtected: 2,
      protectedVolume: '200000000',
      financeRequests: 1,
      fundingOffers: 1,
      advancesFunded: 1,
      advanceVolume: '80000000',
      milestonesSettled: 1,
      funderRepaymentVolume: '90000000',
      supplierResidualVolume: '10000000',
      disputesOpened: 1,
      milestonesRefunded: 1,
      refundVolume: '100000000',
      distinctWallets: 5,
      ...overrides.protocolActivity,
    },
    localPayments: {
      onRampsReported: 1,
      offRampsReported: 0,
      legsChainConfirmed: 0,
      legsMismatched: 1,
      legsUnchecked: 0,
      tryOnboarded: '1000.0000000',
      tryPaidToSuppliers: '0.0000000',
      ...overrides.localPayments,
    },
    northStar: {
      completedLocalPaymentFinanceCycles: 0,
      candidateCycles: 1,
      supplierOffRampCycles: 0,
      buyerOnRampCycles: 0,
      cycles: [
        {
          milestoneId: '2',
          orderId: '2',
          counted: false,
          link: null,
          localPaymentTxHash: null,
          missing: ['no local-money conversion is confirmed on Stellar for a party to this trade'],
        },
      ],
      ...overrides.northStar,
    },
    adoption: {
      externalWallets: 0,
      teamWallets: 0,
      unclassifiedWallets: 5,
      distinctWallets: 5,
      ...overrides.adoption,
    },
    timings: {
      medianOrderCompletionSeconds: 25_615,
      medianTimeToLocalCashSeconds: null,
      ...overrides.timings,
    },
    definitions: {
      protocolActivity: [definition({ key: 'ordersCreated', label: 'Orders created' })],
      localPayments: [
        definition({
          key: 'tryOnboarded',
          label: 'TRY converted into USDC',
          unit: 'try-decimal',
          provenance: 'anchor-reported',
        }),
      ],
      northStar: definition({
        key: 'completedLocalPaymentFinanceCycles',
        label: 'Completed local-payment finance cycles',
        definition:
          'Milestones protected, financed, settled, and connected to a conversion Stellar confirms.',
        provenance: 'anchor-reported-chain-confirmed',
      }),
      adoption: [
        definition({
          key: 'externalWallets',
          label: 'External participating wallets',
          provenance: 'self-declared',
          population: 'external-only',
        }),
      ],
      timings: [
        definition({
          key: 'medianOrderCompletionSeconds',
          label: 'Median time to complete an order',
          unit: 'seconds',
        }),
      ],
      notDerivable: [
        {
          key: 'walletsConnected',
          reason: 'A wallet connection is a browser event, not a chain event.',
        },
      ],
      count: 5,
      ...overrides.definitions,
    },
  };
  return base;
}

/**
 * The metric catalogue: what every public number means and where it comes from.
 *
 * A traction figure without a definition is a claim, not evidence. Every metric
 * the API publishes is declared here once, and the API serves these definitions
 * alongside the values so a judge reading the dashboard can check the wording
 * against the number without reading our source.
 *
 * Three properties matter most, because they are the three ways a metric can
 * mislead:
 *
 *   `provenance`  — can this be verified against a public ledger, or is it a
 *                   report we were given? A bank transfer is never on-chain.
 *   `population`  — does it include our own demo wallets? Nearly everything
 *                   here does, and saying so is the difference between honest
 *                   protocol activity and invented adoption.
 *   `unit`        — money is an exact integer in the asset's base units, never
 *                   a float and never a display string.
 */

/** Where a number can be checked. */
export type Provenance =
  /** Projected from MilvanceCore events on Stellar. Re-derivable from chain. */
  | 'on-chain'
  /** Reported by a client or an Anchor. Not provable by any blockchain. */
  | 'anchor-reported'
  /** A report whose Stellar leg was independently confirmed against Horizon. */
  | 'anchor-reported-chain-confirmed'
  /** Consent metadata a wallet owner supplied about themselves. */
  | 'self-declared';

/** Whose activity a number counts. */
export type Population =
  /** Everyone, including our own demo wallets. Testnet protocol activity. */
  | 'all-participants'
  /** Only wallets explicitly tagged as consenting non-team participants. */
  | 'external-only';

export type Unit = 'count' | 'usdc-base-units' | 'try-decimal' | 'seconds';

export interface MetricDefinition {
  readonly key: string;
  readonly label: string;
  /** What the number means, in a sentence a non-engineer can check. */
  readonly definition: string;
  /** The exact rows or events it is computed from. */
  readonly source: string;
  /** What is deliberately left out. */
  readonly excludes: string;
  readonly unit: Unit;
  readonly provenance: Provenance;
  readonly population: Population;
}

/**
 * Money is published in base units, as a decimal string.
 *
 * USDC on Stellar has 7 decimal places, so 1 USDC is 10_000_000 base units.
 * Aggregation happens in `bigint`; formatting happens in the browser. No
 * authoritative figure is ever a JavaScript number.
 */
export const USDC_DECIMALS = 7;

const chain = {
  unit: 'count',
  provenance: 'on-chain',
  population: 'all-participants',
} as const;
const chainMoney = { ...chain, unit: 'usdc-base-units' } as const;

export const PROTOCOL_METRICS: readonly MetricDefinition[] = [
  {
    ...chain,
    key: 'ordersCreated',
    label: 'Orders created',
    definition: 'Trades a buyer opened on MilvanceCore.',
    source: 'One per `order_created` event, projected to OrderReadModel.',
    excludes: 'Drafts or forms that were never signed — there is no such state.',
  },
  {
    ...chain,
    key: 'ordersAccepted',
    label: 'Orders accepted by a supplier',
    definition: 'Orders whose supplier accepted on chain, so work can be financed.',
    source: 'OrderReadModel rows in status ACTIVE or COMPLETED.',
    excludes: 'Orders still awaiting the supplier.',
  },
  {
    ...chain,
    key: 'ordersCompleted',
    label: 'Orders completed',
    definition: 'Orders where every milestone reached a terminal state on chain.',
    source: 'OrderReadModel rows in status COMPLETED.',
    excludes: 'Orders with any milestone still open.',
  },
  {
    ...chain,
    key: 'milestonesCreated',
    label: 'Milestones created',
    definition: 'Payment stages defined on chain across all orders.',
    source: 'MilestoneReadModel row count.',
    excludes: 'Template suggestions in Trade Lab, which are never written to Stellar.',
  },
  {
    ...chain,
    key: 'milestonesProtected',
    label: 'Milestones protected',
    definition: 'Milestones the buyer fully funded into contract escrow.',
    source: 'Milestones that reached FUNDED or any later state.',
    excludes: 'Partially funded milestones, which the contract does not treat as protected.',
  },
  {
    ...chainMoney,
    key: 'protectedVolume',
    label: 'USDC protected',
    definition: 'Total buyer escrow ever committed to milestones.',
    source:
      'Settled protected amounts + refunded amounts + escrow still held. The three sets are disjoint, so nothing is counted twice and settled escrow is not forgotten.',
    excludes: 'The funder advance, which is separate money and never enters escrow.',
  },
  {
    ...chain,
    key: 'financeRequests',
    label: 'Financing requests',
    definition: 'Suppliers asking for working capital against a protected milestone.',
    source: 'FinanceRequestReadModel row count.',
    excludes: 'Requests that exist only as a form in a browser.',
  },
  {
    ...chain,
    key: 'fundingOffers',
    label: 'Funding offers',
    definition: 'Offers funders published on chain against a request.',
    source: 'FundingOfferReadModel row count.',
    excludes: 'Nothing — withdrawn and expired offers are still offers that were made.',
  },
  {
    ...chain,
    key: 'advancesFunded',
    label: 'Advances funded',
    definition: 'Funders who actually moved their own USDC to a supplier.',
    source: 'FinancePositionReadModel row count, from `advance_funded`.',
    excludes: 'Accepted offers where the funder never paid.',
  },
  {
    ...chainMoney,
    key: 'advanceVolume',
    label: 'USDC advanced to suppliers',
    definition: 'Working capital funders paid to suppliers before settlement.',
    source: 'Sum of FinancePositionReadModel.principal.',
    excludes: 'Buyer escrow. This money never came out of the protected milestone.',
  },
  {
    ...chain,
    key: 'milestonesSettled',
    label: 'Milestones settled',
    definition: 'Verified milestones where escrow was released by the contract.',
    source: 'SettlementReadModel row count.',
    excludes: 'Refunded milestones, which returned escrow to the buyer instead.',
  },
  {
    ...chainMoney,
    key: 'funderRepaymentVolume',
    label: 'USDC repaid to funders',
    definition: 'Paid to funders first out of settled escrow, as the contract enforces.',
    source: 'Sum of SettlementReadModel.funderRepayment.',
    excludes: 'Anything owed after a refund, which the contract does not repay.',
  },
  {
    ...chainMoney,
    key: 'supplierResidualVolume',
    label: 'USDC settled to suppliers',
    definition: 'The remainder of settled escrow, after the funder was made whole.',
    source: 'Sum of SettlementReadModel.supplierPayout.',
    excludes: 'The advance the supplier already received from the funder.',
  },
  {
    ...chain,
    key: 'disputesOpened',
    label: 'Disputes opened',
    definition: 'Milestones escalated to the named resolver.',
    source: 'DisputeReadModel row count.',
    excludes: 'Disagreements settled without opening one on chain.',
  },
  {
    ...chain,
    key: 'milestonesRefunded',
    label: 'Milestones refunded',
    definition: 'Milestones where a resolver returned escrow to the buyer.',
    source: 'RefundReadModel row count.',
    excludes: 'Disputes resolved in the supplier’s favour, which settle instead.',
  },
  {
    ...chainMoney,
    key: 'refundVolume',
    label: 'USDC refunded to buyers',
    definition: 'Escrow returned to buyers by resolver decision.',
    source: 'Sum of RefundReadModel.refundedAmount.',
    excludes:
      'The funder advance, which a refund does not reverse — the supplier keeps it and the funder’s claim is off-chain.',
  },
  {
    ...chain,
    key: 'distinctWallets',
    label: 'Distinct participating wallets',
    definition: 'Wallets that appear in chain state as a party to a trade or a funder.',
    source: 'Distinct addresses across OrderReadModel parties, offers and finance positions.',
    excludes:
      'Wallets that merely connected to the app. A connection is not participation, and counting it would make a click look like a trade.',
  },
];

export const LOCAL_PAYMENT_METRICS: readonly MetricDefinition[] = [
  {
    key: 'onRampsReported',
    label: 'Local-money on-ramps reported',
    definition: 'TRY → USDC conversions reported to us through the Anchor flow.',
    source: 'AnchorTransaction rows with direction TRY_TO_USDC and a completed status.',
    excludes: 'Nothing. These are reports, including ones Stellar does not corroborate.',
    unit: 'count',
    provenance: 'anchor-reported',
    population: 'all-participants',
  },
  {
    key: 'offRampsReported',
    label: 'Local-money off-ramps reported',
    definition: 'USDC → TRY conversions reported to us through the Anchor flow.',
    source: 'AnchorTransaction rows with direction USDC_TO_TRY and a completed status.',
    excludes: 'Nothing. These are reports, including ones Stellar does not corroborate.',
    unit: 'count',
    provenance: 'anchor-reported',
    population: 'all-participants',
  },
  {
    key: 'legsChainConfirmed',
    label: 'Local-payment legs confirmed on Stellar',
    definition:
      'Reported conversions whose Stellar side was checked against Horizon and matched: approved USDC asset, right direction, right wallet, right amount.',
    source: 'AnchorTransaction rows with stellarLegStatus CONFIRMED.',
    excludes:
      'The fiat side, which no blockchain can prove, and reports whose transaction hash does not match what Stellar records.',
    unit: 'count',
    provenance: 'anchor-reported-chain-confirmed',
    population: 'all-participants',
  },
  {
    key: 'legsMismatched',
    label: 'Reported legs Stellar contradicts',
    definition:
      'Reports whose transaction hash exists but does not match the report. Published because hiding them would make the confirmed count look complete.',
    source: 'AnchorTransaction rows with stellarLegStatus MISMATCHED.',
    excludes: 'Reports that were simply never checked.',
    unit: 'count',
    provenance: 'anchor-reported-chain-confirmed',
    population: 'all-participants',
  },
  {
    key: 'tryOnboarded',
    label: 'TRY converted into USDC',
    definition: 'Local currency reported as entering the flow through the Anchor.',
    source: 'Sum of AnchorTransaction.sourceAmount for completed TRY_TO_USDC rows.',
    excludes:
      'Any independent verification — a bank leg leaves no trace on Stellar, so this figure is the Anchor’s word.',
    unit: 'try-decimal',
    provenance: 'anchor-reported',
    population: 'all-participants',
  },
  {
    key: 'tryPaidToSuppliers',
    label: 'TRY paid out to suppliers',
    definition: 'Local currency reported as reaching a supplier wallet’s owner.',
    source: 'Sum of AnchorTransaction.destinationAmount for completed USDC_TO_TRY rows.',
    excludes: 'The same caveat: the fiat payout is Anchor-reported, not on-chain proof.',
    unit: 'try-decimal',
    provenance: 'anchor-reported',
    population: 'all-participants',
  },
];

/**
 * The north-star metric, stated so it can be argued with.
 *
 * AGENT.md §7.4 permits a cycle to count only when it contains an
 * Anchor/local-payment action, a funded milestone, supplier financing and
 * meaningful contract progression. All four are required here, and the
 * local-payment leg must additionally survive an independent Stellar check —
 * a self-report alone is not evidence, per the read layer's standing rule.
 */
export const NORTH_STAR: MetricDefinition = {
  key: 'completedLocalPaymentFinanceCycles',
  label: 'Completed local-payment finance cycles',
  definition:
    'Milestones that were protected by a buyer on chain, financed by a real funder advance, settled by the contract, AND connected to a local-money conversion whose Stellar leg Stellar itself confirms.',
  source:
    'MilestoneReadModel × SettlementReadModel × FinancePositionReadModel, joined to an AnchorTransaction with stellarLegStatus CONFIRMED belonging to a party of that trade and timed consistently with the cycle.',
  excludes:
    'Cycles missing any leg, and any link resting on similar amounts. USDC is fungible, so the link is wallet identity plus ordering in time, never a claim that the same units flowed through.',
  unit: 'count',
  provenance: 'anchor-reported-chain-confirmed',
  population: 'all-participants',
};

export const ADOPTION_METRICS: readonly MetricDefinition[] = [
  {
    key: 'externalWallets',
    label: 'External participating wallets',
    definition:
      'Wallets active in chain state whose owner explicitly consented to be counted and declared themselves not part of the team.',
    source: 'Chain-active addresses joined to DemoParticipant with consentToCount and not isTeam.',
    excludes:
      'Every untagged wallet. External participation is opt-in and never inferred, so an unclassified wallet is never promoted into this number.',
    unit: 'count',
    provenance: 'self-declared',
    population: 'external-only',
  },
  {
    key: 'teamWallets',
    label: 'Team wallets',
    definition: 'Chain-active wallets their owner declared as belonging to the team.',
    source: 'Chain-active addresses joined to DemoParticipant with isTeam.',
    excludes: 'Untagged wallets, which are reported separately rather than assumed.',
    unit: 'count',
    provenance: 'self-declared',
    population: 'all-participants',
  },
  {
    key: 'unclassifiedWallets',
    label: 'Unclassified wallets',
    definition: 'Chain-active wallets nobody has classified either way.',
    source: 'Chain-active addresses with no DemoParticipant row.',
    excludes: 'Nothing. Published so the three buckets visibly add up to the total.',
    unit: 'count',
    provenance: 'self-declared',
    population: 'all-participants',
  },
];

export const TIMING_METRICS: readonly MetricDefinition[] = [
  {
    key: 'medianOrderCompletionSeconds',
    label: 'Median time to complete an order',
    definition: 'From order creation to its last milestone reaching a terminal state.',
    source:
      'Median over COMPLETED orders of (latest settlement or refund time − OrderReadModel.createdAt), both chain timestamps.',
    excludes: 'Orders still open. Null until at least one order has completed.',
    unit: 'seconds',
    provenance: 'on-chain',
    population: 'all-participants',
  },
  {
    key: 'medianTimeToLocalCashSeconds',
    label: 'Median time from advance to local cash',
    definition:
      'How long a supplier waited between receiving a funder advance and a confirmed conversion into local money.',
    source:
      'Median over confirmed supplier off-ramp legs of (Stellar leg time − FinancePositionReadModel.fundedAt).',
    excludes:
      'Unconfirmed reports. Null until at least one supplier off-ramp is confirmed on Stellar.',
    unit: 'seconds',
    provenance: 'anchor-reported-chain-confirmed',
    population: 'all-participants',
  },
];

/**
 * Metrics named in AGENT.md §29 that this API deliberately does not publish,
 * with the reason. Serving the list is the honest alternative to quietly
 * dropping them and letting the omission read as an oversight.
 */
export const NOT_DERIVABLE: readonly { readonly key: string; readonly reason: string }[] = [
  {
    key: 'walletsConnected',
    reason:
      'A wallet connection is a browser event, not a chain event. Counting it would make a click look like usage, so participation is measured from chain state instead.',
  },
  {
    key: 'financedShipmentOrDeliveryMilestones',
    reason:
      'MilvanceCore stores no stage name. Names like "Shipment" come from Trade Lab templates and live only in the browser that chose them, so this cannot be derived from chain state.',
  },
  {
    key: 'medianDemoCompletionTime',
    reason:
      'Published as medianOrderCompletionSeconds, measured between chain timestamps rather than between screens a person visited.',
  },
];

export const ALL_DEFINITIONS: readonly MetricDefinition[] = [
  ...PROTOCOL_METRICS,
  ...LOCAL_PAYMENT_METRICS,
  NORTH_STAR,
  ...ADOPTION_METRICS,
  ...TIMING_METRICS,
];

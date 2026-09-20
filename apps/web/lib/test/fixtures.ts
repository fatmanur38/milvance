import type {
  Milestone,
  MilestoneFinance,
  Offer,
  OrderWithMilestones,
  Position,
} from '../api/schemas';

/**
 * TEST-ONLY builders in the exact shapes the API returns.
 *
 * They exist so tests can express one scenario each. Nothing in the product
 * imports this file, and the workspace never renders fabricated records.
 */
export const WALLETS = {
  buyer: 'GCKFEDBA24UY7Q3KTIJC7HDUMCJPBDAJ5NGDLGKMLFMWMSEH47VXEKHW',
  supplier: 'GBBS3FS2CXYQRUHDCGGAYTQCJ6BELVSWZSKXOGMSNWWBYMZ2RGZDYHXQ',
  attestor: 'GDU5EPX7YMT65OJRDNQYFKK7S2MDET6E4KHLFSSZZNZMQUHLRJAKRXDH',
  resolver: 'GD75QRXBDJ7F3P3I4ZLQJISCVA2FHE3ETPY5GFB3IA5UZSDA7ZJP3NBD',
  funder: 'GDXYO6FJCNXZEWGXD54GT76FGFYLOLSOGSOJLNQ6WGHCGEQPO7NTE73M',
  outsider: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7',
} as const;

const CONTRACT = 'CCN6AZHLN2BQPCDZWXJGA3NRJEJ56V5JK3M4VZ5QFKQ3NSJBN6RVTKRX';
const HASH = 'a'.repeat(64);
const provenance = {
  source: 'soroban-projection' as const,
  network: 'testnet',
  contractId: CONTRACT,
  lastEventId: '0000000000000000001-0000000000',
  lastLedger: '4761475',
};

export function milestone(overrides: Partial<Milestone> = {}): Milestone {
  return {
    milestoneId: '1',
    orderId: '1',
    index: 0,
    amount: '20000000000', // 2,000 USDC
    fundedAmount: '20000000000',
    fullyFunded: true,
    deadline: null,
    evidenceHash: null,
    status: 'FUNDED',
    derivedStatus: 'ON_TRACK',
    createdLedger: '4761475',
    createdTxHash: HASH,
    createdAt: '2026-09-19T15:16:02.000Z',
    provenance,
    ...overrides,
  };
}

export function order(overrides: Partial<OrderWithMilestones> = {}): OrderWithMilestones {
  return {
    orderId: '1',
    buyer: WALLETS.buyer,
    supplier: WALLETS.supplier,
    attestor: WALLETS.attestor,
    resolver: WALLETS.resolver,
    settlementAsset: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    status: 'ACTIVE',
    createdLedger: '4761475',
    createdTxHash: HASH,
    createdAt: '2026-09-19T15:16:02.000Z',
    provenance,
    milestones: [milestone()],
    ...overrides,
  };
}

export function offer(overrides: Partial<Offer> = {}): Offer {
  return {
    offerId: '1',
    milestoneId: '1',
    funder: WALLETS.funder,
    principal: '14000000000', // 1,400 USDC
    repayment: '14450000000', // 1,445 USDC
    status: 'OPEN',
    expiresAt: '2099-01-01T00:00:00.000Z',
    createdAt: '2026-09-19T16:00:00.000Z',
    ...overrides,
  };
}

export function position(overrides: Partial<Position> = {}): Position {
  return {
    milestoneId: '1',
    offerId: '1',
    funder: WALLETS.funder,
    supplier: WALLETS.supplier,
    principal: '14000000000',
    repayment: '14450000000',
    protectedAmountAtFunding: '20000000000',
    status: 'ACTIVE',
    fundedAt: '2026-09-19T17:00:00.000Z',
    fundedTxHash: HASH,
    repaidAt: null,
    closedAt: null,
    ...overrides,
  };
}

export function finance(overrides: Partial<MilestoneFinance> = {}): MilestoneFinance {
  return {
    milestoneId: '1',
    buyerProtectedEscrow: '20000000000',
    funderAdvance: '0',
    request: null,
    offers: [],
    positions: [],
    settlement: null,
    refund: null,
    ...overrides,
  };
}

export function openRequest(expiresAt = '2099-01-01T00:00:00.000Z') {
  return {
    milestoneId: '1',
    supplier: WALLETS.supplier,
    requestedPrincipal: '14000000000',
    protectedAmount: '20000000000',
    status: 'OPEN' as const,
    expiresAt,
    cancelledWhileExpired: null,
    createdAt: '2026-09-19T16:00:00.000Z',
  };
}

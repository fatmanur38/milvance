/**
 * Turning transaction failures into something a person can act on.
 *
 * Two traps this module exists to avoid:
 *
 *  1. Showing a raw RPC dump ("HostError: Error(Contract, #54)…") to a buyer.
 *  2. Believing the generated bindings' error name when the failure did not
 *     come from MilvanceCore at all. The SDK maps the FIRST
 *     `Error(Contract, #N)` in a simulation message through OUR contract's
 *     error table. When the USDC token contract fails inside our call — #10 is
 *     its "balance is not sufficient" — that becomes MilvanceCore's #10,
 *     "OrderNotFound". Token failures are therefore recognised from the raw
 *     simulation text first, and only then is the contract's own error trusted.
 */

export type TxFailureKind =
  | 'rejected'
  | 'wrong-network'
  | 'account-changed'
  | 'not-connected'
  | 'unfunded-account'
  | 'insufficient-balance'
  | 'missing-trustline'
  | 'contract'
  | 'rpc'
  | 'timeout'
  | 'unknown';

export interface TxFailure {
  readonly kind: TxFailureKind;
  readonly message: string;
  /** Technical detail for the collapsed "details" view. Never a key or token. */
  readonly detail?: string;
}

/** A contract-level rejection surfaced by simulation, before anything is signed. */
export class ContractRejection extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ContractRejection';
  }
}

/** A failure raised by the USDC token contract rather than by MilvanceCore. */
export class TokenFailure extends Error {
  constructor(
    readonly kind: 'insufficient-balance' | 'missing-trustline' | 'unfunded-account',
    detail: string,
  ) {
    super(detail);
    this.name = 'TokenFailure';
  }
}

/**
 * Recognise a token-contract failure inside a raw simulation error.
 *
 * Matches the Stellar Asset Contract's diagnostic text, which names the
 * condition explicitly, so this does not depend on error-code numbering.
 */
export function tokenFailureIn(simulationError: string): TokenFailure | null {
  const text = simulationError.toLowerCase();
  if (text.includes('trustline entry is missing') || text.includes('trustline is missing')) {
    return new TokenFailure('missing-trustline', simulationError);
  }
  if (text.includes('balance is not sufficient') || text.includes('insufficient balance')) {
    return new TokenFailure('insufficient-balance', simulationError);
  }
  if (text.includes('account entry is missing') || text.includes('account not found')) {
    return new TokenFailure('unfunded-account', simulationError);
  }
  return null;
}

/** Product explanations for MilvanceCore's own error codes. */
const CONTRACT_MESSAGES: Record<string, string> = {
  Unauthorized: 'This wallet is not allowed to take that action on this order.',
  OrderNotFound: 'That order does not exist on Stellar.',
  MilestoneNotFound: 'That milestone does not exist on Stellar.',
  InvalidOrderStatus:
    'The order is no longer in a state that allows this. Refresh to see its latest state.',
  InvalidMilestoneStatus:
    'The milestone has moved on since this page loaded. Refresh to see its latest state.',
  OrderHasNoMilestones: 'Add at least one milestone before the supplier can accept the order.',
  InvalidParties: 'Buyer, supplier, attestor and resolver must be four different, valid accounts.',
  InvalidAttestor: 'The attestor must be independent of the buyer and supplier.',
  InvalidResolver: 'The resolver must be independent of the buyer and supplier.',
  AttestorResolverConflict: 'The attestor and the resolver must be different accounts.',
  InvalidAmount: 'Enter an amount greater than zero.',
  InvalidDeadline: 'The target date must be in the future.',
  MilestoneLimitReached: 'This order already has the maximum number of milestones.',
  InvalidAsset: 'Only the approved Testnet USDC can protect a milestone.',
  Overfunded: 'That would protect more than the milestone amount.',
  InsufficientEscrow: 'The milestone does not hold enough protected money for that.',
  FinanceRequestActive: 'A working-capital request is already open for this milestone.',
  FinanceRequestExpired: 'This working-capital request has expired.',
  InvalidFinanceRequestStatus: 'The working-capital request is no longer open.',
  MilestoneNotFullyFunded:
    'Working capital can only be requested once the buyer has fully protected the milestone.',
  OfferNotFound: 'That funding offer no longer exists.',
  InvalidOfferStatus: 'That funding offer is no longer available.',
  OfferExpired: 'That funding offer has expired.',
  PrincipalMismatch: 'An offer must advance exactly the working capital the supplier requested.',
  InvalidRepayment: 'Repayment cannot be less than the advance.',
  RepaymentExceedsEscrow:
    'Repayment cannot exceed the protected milestone amount it is repaid from.',
  OfferLimitReached: 'This milestone has reached its maximum number of offers.',
  InvalidFunder:
    'A funder must be independent: the buyer, supplier, attestor and resolver cannot fund this order.',
  NoAcceptedOffer: 'The supplier has not chosen an offer yet.',
  AlreadyFinanced: 'This milestone already has an active funder. It cannot be financed twice.',
  InvalidExpiry: 'Choose an expiry in the allowed window.',
  OfferStillLive: 'The chosen offer is still valid; it can only be released after it expires.',
  EvidenceNotFound: 'No evidence has been submitted for this milestone yet.',
  EvidenceMismatch: 'That evidence does not match the commitment on Stellar.',
  InvalidEvidence: 'That is not a valid evidence commitment.',
  DisputeAlreadyOpen: 'A dispute is already open for this milestone.',
  InvalidDisputeStatus: 'This dispute has already been resolved.',
  NothingToSettle: 'There is no protected money to release on this milestone.',
  NoPartialFunding: 'There is no partial protection to return.',
  OfferAlreadyAccepted: 'An offer has already been chosen for this milestone.',
};

export function contractMessage(code: string): string {
  return CONTRACT_MESSAGES[code] ?? `Stellar rejected the action (${code}).`;
}

function text(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/**
 * Classify any failure from the transaction pipeline.
 *
 * `stage` matters for one case: a thrown error while waiting for the wallet is
 * almost always the person saying no, and we should say so plainly rather than
 * reporting it as a network failure.
 */
export function classifyTxError(error: unknown, stage: string): TxFailure {
  const detail = text(error).slice(0, 600);

  if (error instanceof TokenFailure) {
    const messages = {
      'insufficient-balance': 'This wallet does not hold enough Testnet USDC for this.',
      'missing-trustline':
        'A USDC trustline is missing. Both the sender and the receiver need one before USDC can move.',
      'unfunded-account': 'This Stellar account is not funded on Testnet yet.',
    } as const;
    return { kind: error.kind, message: messages[error.kind], detail };
  }
  if (error instanceof ContractRejection) {
    return { kind: 'contract', message: contractMessage(error.code), detail: error.code };
  }

  const lower = detail.toLowerCase();
  if (lower.includes('switch freighter to stellar testnet')) {
    return {
      kind: 'wrong-network',
      message: 'Switch your wallet to Stellar Testnet and try again.',
    };
  }
  if (lower.includes('account changed') || lower.includes('different account')) {
    return {
      kind: 'account-changed',
      message: 'Your wallet account changed. Reconnect and try again.',
    };
  }
  if (lower.includes('connect your wallet')) {
    return { kind: 'not-connected', message: 'Connect your wallet first.' };
  }
  // Raised while building the transaction, when Stellar has no account for the
  // signer: a Freighter account that exists in the extension but was never
  // funded on Testnet. The raw text names the address and explains nothing.
  if (lower.includes('account not found')) {
    return {
      kind: 'unfunded-account',
      message:
        'This Stellar account does not exist on Testnet yet. Fund it with Friendbot in Freighter, then try again.',
      detail,
    };
  }
  if (
    stage === 'awaiting-signature' ||
    /reject|declin|denied|cancel+ed by (the )?user|user closed/.test(lower)
  ) {
    return {
      kind: 'rejected',
      message: 'You declined the request in your wallet. Nothing was submitted.',
      detail,
    };
  }
  if (/timed? ?out|waited .* but|not finalized|try_again_later/.test(lower)) {
    return {
      kind: 'timeout',
      message:
        'Stellar has not confirmed this yet. It may still land — check the explorer before retrying.',
      detail,
    };
  }
  if (/failed to fetch|network|econn|fetch failed|http 5\d\d|rpc/.test(lower)) {
    return {
      kind: 'rpc',
      message: 'Could not reach the Stellar network. Nothing changed; try again.',
      detail,
    };
  }
  return { kind: 'unknown', message: 'The transaction did not complete.', detail };
}

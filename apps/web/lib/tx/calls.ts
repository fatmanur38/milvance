import { Buffer } from 'buffer';

import { DisputeResolution, type Client } from '@milvance/contract-bindings';

import { testnetDeployment } from '../wallet/config';

/**
 * Every MilvanceCore write the workspace can request, as data.
 *
 * Each maps 1:1 onto a method of the PKG-05 generated `Client`, which remains
 * the only thing that builds a MilvanceCore transaction. No handwritten XDR,
 * no second invocation builder.
 *
 * Amounts are `bigint` integer units end to end. Identifiers are decimal
 * strings from the read model and become `bigint` only here.
 */
export type ContractCall =
  | { kind: 'create-order'; supplier: string; attestor: string; resolver: string }
  | { kind: 'create-milestone'; orderId: string; amount: bigint; deadline: bigint | null }
  | { kind: 'accept-order'; orderId: string }
  | { kind: 'cancel-order'; orderId: string }
  | { kind: 'fund-milestone'; milestoneId: string; amount: bigint }
  | { kind: 'cancel-partial-funding'; milestoneId: string }
  | { kind: 'request-finance'; milestoneId: string; principal: bigint; expiresAt: bigint }
  | { kind: 'cancel-finance-request'; milestoneId: string }
  | {
      kind: 'make-offer';
      milestoneId: string;
      principal: bigint;
      repayment: bigint;
      expiresAt: bigint;
    }
  | { kind: 'cancel-offer'; offerId: string }
  | { kind: 'accept-offer'; offerId: string }
  | { kind: 'fund-advance'; milestoneId: string }
  | { kind: 'release-expired-acceptance'; milestoneId: string }
  | { kind: 'submit-evidence'; milestoneId: string; evidenceHash: string }
  | { kind: 'verify-milestone'; milestoneId: string; evidenceHash: string }
  | { kind: 'settle-milestone'; milestoneId: string }
  | { kind: 'open-dispute'; milestoneId: string }
  | { kind: 'resolve-dispute'; milestoneId: string; resolution: 'settle' | 'refund' };

/** What each action is called in the product, shown in wallet review and feedback. */
export const CALL_LABELS: Record<ContractCall['kind'], string> = {
  'create-order': 'Create order',
  'create-milestone': 'Add milestone',
  'accept-order': 'Accept order',
  'cancel-order': 'Cancel order',
  'fund-milestone': 'Protect milestone payment',
  'cancel-partial-funding': 'Return partial protection',
  'request-finance': 'Request working capital',
  'cancel-finance-request': 'Close working-capital request',
  'make-offer': 'Make funding offer',
  'cancel-offer': 'Withdraw funding offer',
  'accept-offer': 'Choose this offer',
  'fund-advance': 'Send working capital',
  'release-expired-acceptance': 'Release unfunded offer',
  'submit-evidence': 'Submit evidence',
  'verify-milestone': 'Verify milestone',
  'settle-milestone': 'Release milestone payment',
  'open-dispute': 'Open dispute',
  'resolve-dispute': 'Resolve dispute',
};

function digestBytes(hex: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error('Evidence commitment must be a SHA-256 digest in lower-case hex.');
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Build (and simulate) the transaction for one call.
 *
 * `wallet` fills every argument the contract uses to identify the acting
 * party — `buyer`, `funder`, `caller`. It is always the connected wallet;
 * the workspace never asks the contract to act for somebody else.
 */
export function buildCall(client: Client, call: ContractCall, wallet: string) {
  switch (call.kind) {
    case 'create-order':
      return client.create_order({
        buyer: wallet,
        supplier: call.supplier,
        attestor: call.attestor,
        resolver: call.resolver,
      });
    case 'create-milestone':
      return client.create_milestone({
        order_id: BigInt(call.orderId),
        amount: call.amount,
        deadline: call.deadline ?? undefined,
      });
    case 'accept-order':
      return client.accept_order({ order_id: BigInt(call.orderId) });
    case 'cancel-order':
      return client.cancel_order({ order_id: BigInt(call.orderId) });
    case 'fund-milestone':
      return client.fund_milestone({
        milestone_id: BigInt(call.milestoneId),
        amount: call.amount,
        asset: testnetDeployment.usdcAssetContractId,
      });
    case 'cancel-partial-funding':
      return client.cancel_partial_funding({ milestone_id: BigInt(call.milestoneId) });
    case 'request-finance':
      return client.request_finance({
        milestone_id: BigInt(call.milestoneId),
        requested_principal: call.principal,
        expires_at: call.expiresAt,
      });
    case 'cancel-finance-request':
      return client.cancel_finance_request({ milestone_id: BigInt(call.milestoneId) });
    case 'make-offer':
      return client.make_offer({
        milestone_id: BigInt(call.milestoneId),
        funder: wallet,
        principal: call.principal,
        repayment: call.repayment,
        expires_at: call.expiresAt,
      });
    case 'cancel-offer':
      return client.cancel_offer({ offer_id: BigInt(call.offerId) });
    case 'accept-offer':
      return client.accept_offer({ offer_id: BigInt(call.offerId) });
    case 'fund-advance':
      return client.fund_advance({ milestone_id: BigInt(call.milestoneId) });
    case 'release-expired-acceptance':
      return client.release_expired_acceptance({ milestone_id: BigInt(call.milestoneId) });
    case 'submit-evidence':
      return client.submit_evidence({
        milestone_id: BigInt(call.milestoneId),
        evidence_hash: digestBytes(call.evidenceHash),
      });
    case 'verify-milestone':
      return client.attest_milestone({
        milestone_id: BigInt(call.milestoneId),
        evidence_hash: digestBytes(call.evidenceHash),
      });
    case 'settle-milestone':
      return client.settle_milestone({ milestone_id: BigInt(call.milestoneId), caller: wallet });
    case 'open-dispute':
      return client.open_dispute({ milestone_id: BigInt(call.milestoneId), caller: wallet });
    case 'resolve-dispute':
      return client.resolve_dispute({
        milestone_id: BigInt(call.milestoneId),
        resolution:
          call.resolution === 'settle' ? DisputeResolution.Settle : DisputeResolution.Refund,
      });
  }
}

import type { AnchorTransaction } from '@milvance/anchor';
import { AnchorError } from '@milvance/anchor';

import { anchorConfig } from './config';

/**
 * Builds the USDC payment that settles a withdrawal.
 *
 * The memo is the whole point. A SEP-6 withdrawal is matched to its payment by
 * memo; sending the USDC without it leaves the funds sitting at the Anchor with
 * nothing tying them to the customer. So this refuses to build an unmemoed
 * payment rather than producing a transaction the user could sign and strand.
 *
 * The returned XDR is **unsigned**. The user's wallet signs it; no Milvance
 * code holds a key.
 */
export interface WithdrawalPaymentPlan {
  readonly destination: string;
  readonly amount: string;
  readonly memo: string;
  readonly memoType: 'text' | 'id' | 'hash';
}

export function planWithdrawalPayment(
  transaction: AnchorTransaction,
  amount: string,
): WithdrawalPaymentPlan {
  if (!transaction.withdrawAnchorAccount) {
    throw new AnchorError('withdraw_failed', 'The provider did not say where to send the USDC.');
  }
  if (!transaction.withdrawMemo || !transaction.withdrawMemoType) {
    throw new AnchorError(
      'missing_memo',
      'The provider did not return the payment reference this withdrawal needs.',
    );
  }
  return {
    destination: transaction.withdrawAnchorAccount,
    amount,
    memo: transaction.withdrawMemo,
    memoType: transaction.withdrawMemoType,
  };
}

/** Builds the unsigned payment transaction XDR for a planned withdrawal. */
export async function buildWithdrawalPaymentXdr(
  sourceAccount: string,
  plan: WithdrawalPaymentPlan,
): Promise<string> {
  const { Asset, BASE_FEE, Horizon, Memo, Operation, TransactionBuilder } =
    await import('@stellar/stellar-sdk');

  const horizon = new Horizon.Server('https://horizon-testnet.stellar.org');
  const account = await horizon.loadAccount(sourceAccount);

  const memo =
    plan.memoType === 'id'
      ? Memo.id(plan.memo)
      : plan.memoType === 'hash'
        ? Memo.hash(plan.memo)
        : Memo.text(plan.memo);

  return new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: anchorConfig.networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination: plan.destination,
        asset: new Asset(anchorConfig.assetCode, anchorConfig.usdcIssuer),
        amount: plan.amount,
      }),
    )
    .addMemo(memo)
    .setTimeout(180)
    .build()
    .toXDR();
}

/** Submits a wallet-signed payment to Horizon and returns its hash. */
export async function submitSignedPayment(signedXdr: string): Promise<string> {
  const { Horizon, TransactionBuilder } = await import('@stellar/stellar-sdk');
  const horizon = new Horizon.Server('https://horizon-testnet.stellar.org');
  const transaction = TransactionBuilder.fromXDR(signedXdr, anchorConfig.networkPassphrase);
  const result = await horizon.submitTransaction(transaction);
  return result.hash;
}

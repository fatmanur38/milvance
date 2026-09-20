import { Client } from '@milvance/contract-bindings';
import { rpc } from '@stellar/stellar-sdk';

import { testnetDeployment } from '../wallet/config';
import { buildCall, type ContractCall } from './calls';
import { ContractRejection, tokenFailureIn } from './errors';

/**
 * Runs one MilvanceCore action through the connected wallet.
 *
 *   simulate → (contract says no? stop, nothing signed)
 *            → wallet signature (the user's, in Freighter)
 *            → submit → wait for the ledger to confirm
 *
 * The backend is not in this path at all. It never sees the transaction before
 * confirmation and never signs anything — it learns about the result the same
 * way everyone else does: from the contract event, via the indexer.
 */

export type RunnerStage = 'preparing' | 'awaiting-signature' | 'submitted' | 'confirming';

export interface RunnerDeps {
  readonly address: string;
  /** Signs with the user's wallet. Throws if they decline. */
  readonly sign: (xdr: string) => Promise<string>;
  readonly onStage: (stage: RunnerStage, hash?: string) => void;
}

export interface RunnerResult {
  readonly hash: string;
  /** Ledger that included the transaction; the indexer must reach it. */
  readonly ledger: number;
}

export function contractClient(address: string, sign: (xdr: string) => Promise<string>): Client {
  return new Client({
    contractId: testnetDeployment.contractId,
    networkPassphrase: testnetDeployment.networkPassphrase,
    rpcUrl: testnetDeployment.rpcUrl,
    publicKey: address,
    signTransaction: async (xdr) => ({ signedTxXdr: await sign(xdr) }),
  });
}

export async function runContractCall(
  call: ContractCall,
  deps: RunnerDeps,
  client: Client = contractClient(deps.address, deps.sign),
): Promise<RunnerResult> {
  deps.onStage('preparing');
  const transaction = await buildCall(client, call, deps.address);

  // Read the raw simulation first. The generated bindings would otherwise
  // report a USDC token failure as whichever MilvanceCore error happens to
  // share its number.
  const simulation = transaction.simulation;
  if (simulation !== undefined && rpc.Api.isSimulationError(simulation)) {
    const token = tokenFailureIn(simulation.error);
    if (token !== null) throw token;
  }

  const result = transaction.result as { isErr(): boolean; unwrapErr(): { message: string } };
  if (result.isErr()) {
    // A contract rejection found in simulation. Nothing is signed or sent.
    throw new ContractRejection(result.unwrapErr().message);
  }

  deps.onStage('awaiting-signature');
  await transaction.sign();

  const sent = await transaction.send({
    onSubmitted: (response) => {
      if (response?.hash) deps.onStage('submitted', response.hash);
    },
    onProgress: () => deps.onStage('confirming'),
  });
  const response = sent.getTransactionResponse;
  if (response === undefined || response.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(
      `Transaction was not confirmed successfully (${response?.status ?? 'no response'}).`,
    );
  }
  return { hash: response.txHash, ledger: response.ledger };
}

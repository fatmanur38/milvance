'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useReducer } from 'react';

import { api, queryKeys } from '../api/queries';
import { canSign } from '../wallet/controller';
import { useWallet } from '../wallet/provider';
import { CALL_LABELS, type ContractCall } from './calls';
import { classifyTxError } from './errors';
import { IDLE, txReducer, waitForIndexer, type TxState } from './lifecycle';
import { runContractCall, type RunnerStage } from './runner';

export interface ContractTransaction {
  readonly state: TxState;
  /** The connected wallet address, or '' when none — used for pre-flight checks. */
  readonly walletAddress: string;
  readonly run: (call: ContractCall) => Promise<boolean>;
  readonly reset: () => void;
}

/**
 * One wallet-signed MilvanceCore action, from review to refreshed workspace.
 *
 * Read-after-write is explicit: after Stellar confirms, we wait for the
 * indexer to reach the transaction's ledger, then re-read every chain-derived
 * query. The UI never edits its own copy of financial state to "look done".
 */
export function useContractTransaction(): ContractTransaction {
  const { controller, state: wallet } = useWallet();
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(txReducer, IDLE);

  const run = useCallback(
    async (call: ContractCall): Promise<boolean> => {
      if (!canSign(wallet) || wallet.address === undefined) {
        dispatch({ type: 'start', label: CALL_LABELS[call.kind] });
        dispatch({
          type: 'failed',
          failure: classifyTxError(
            new Error(
              wallet.phase === 'wrong-network'
                ? 'Switch Freighter to Stellar Testnet before signing.'
                : 'Connect your wallet before signing.',
            ),
            'preparing',
          ),
        });
        return false;
      }

      dispatch({ type: 'start', label: CALL_LABELS[call.kind] });
      let stage: RunnerStage = 'preparing';
      try {
        const result = await runContractCall(call, {
          address: wallet.address,
          sign: (xdr) => controller.signRaw(xdr),
          onStage: (next, hash) => {
            stage = next;
            dispatch({ type: 'stage', stage: next, ...(hash !== undefined ? { hash } : {}) });
          },
        });
        dispatch({ type: 'confirmed', hash: result.hash, ledger: result.ledger });
        const outcome = await waitForIndexer(result.ledger, api.indexerStatus);
        await queryClient.invalidateQueries({ queryKey: queryKeys.chain });
        dispatch({ type: outcome === 'synced' ? 'synced' : 'sync-delayed' });
        return true;
      } catch (error) {
        dispatch({ type: 'failed', failure: classifyTxError(error, stage) });
        return false;
      }
    },
    [controller, queryClient, wallet],
  );

  const reset = useCallback(() => dispatch({ type: 'reset' }), []);
  return { state, run, reset, walletAddress: wallet.address ?? '' };
}

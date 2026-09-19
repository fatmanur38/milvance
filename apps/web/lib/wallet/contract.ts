'use client';

import { Client } from '@milvance/contract-bindings';
import { StrKey } from '@stellar/stellar-sdk';
import { testnetDeployment } from './config';
import type {
  ChainOrder,
  ContractPort,
  CreateOrderInput,
  PreparedOrder,
  WalletPort,
} from './ports';

export function validateParties(buyer: string, input: CreateOrderInput): void {
  const parties = [buyer, input.supplier, input.attestor, input.resolver];
  if (parties.some((address) => !StrKey.isValidEd25519PublicKey(address))) {
    throw new Error('Each party must have a valid classic Stellar public address (G...).');
  }
  if (new Set(parties).size !== parties.length) {
    throw new Error('Buyer, supplier, attestor, and resolver must have different addresses.');
  }
}

/** The generated PKG-05 Client is the sole MilvanceCore transaction builder. */
export class MilvanceContract implements ContractPort {
  constructor(private readonly wallet: WalletPort) {}

  private client(publicKey: string): Client {
    return new Client({
      contractId: testnetDeployment.contractId,
      networkPassphrase: testnetDeployment.networkPassphrase,
      rpcUrl: testnetDeployment.rpcUrl,
      publicKey,
      signTransaction: async (xdr) => ({
        signedTxXdr: await this.wallet.signTransaction(xdr, publicKey),
      }),
    });
  }

  async prepareCreateOrder(buyer: string, input: CreateOrderInput): Promise<PreparedOrder> {
    validateParties(buyer, input);
    const transaction = await this.client(buyer).create_order({ buyer, ...input });
    // The generated method simulates. A contract-level Err is never submitted.
    if (transaction.result.isErr()) throw new Error(transaction.result.unwrapErr().message);
    const orderId = transaction.result.unwrap().toString();
    return {
      orderId,
      sign: async () => transaction.sign(),
      send: async (onSubmitted, onConfirming) => {
        const sent = await transaction.send({
          onSubmitted: (response) => {
            if (response?.hash) onSubmitted(response.hash);
          },
          onProgress: () => onConfirming(),
        });
        const response = sent.getTransactionResponse;
        if (response?.status !== 'SUCCESS') {
          throw new Error(
            `Transaction was not confirmed successfully (${response?.status ?? 'unknown'}).`,
          );
        }
        return response.txHash;
      },
    };
  }

  async readOrder(buyer: string, orderId: string): Promise<ChainOrder> {
    const result = (await this.client(buyer).get_order({ order_id: BigInt(orderId) })).result;
    if (result.isErr()) throw new Error(result.unwrapErr().message);
    const order = result.unwrap();
    return {
      id: order.id.toString(),
      buyer: order.buyer,
      supplier: order.supplier,
      attestor: order.attestor,
      resolver: order.resolver,
      asset: order.asset,
      status: String(order.status),
    };
  }
}

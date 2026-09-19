import { Injectable } from '@nestjs/common';
import { Client } from '@milvance/contract-bindings';

import type { ApiConfig } from '../config';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Compares a derived row against the authoritative contract state.
 *
 * This is the one place the backend reads the chain directly rather than through
 * its own projections, and it exists to answer a single question honestly: *is
 * the read model still telling the truth?*
 *
 * It only ever READS. Reconciliation never writes a projection and never
 * submits a transaction — if the database disagrees with the chain, the correct
 * repair is to replay the indexer, not to patch a row into agreement. Patching
 * would let a bug in this file silently become "financial state".
 *
 * All contract calls are simulations, so they cost nothing and change nothing.
 */

export interface FieldComparison {
  readonly field: string;
  readonly chain: string | null;
  readonly database: string | null;
  readonly matches: boolean;
}

export interface ReconciliationResult {
  readonly entity: string;
  readonly id: string;
  readonly reconciled: boolean;
  readonly presentOnChain: boolean;
  readonly presentInDatabase: boolean;
  readonly fields: readonly FieldComparison[];
  readonly checkedAt: string;
}

const ORDER_STATUS_BY_INDEX = ['CREATED', 'ACTIVE', 'COMPLETED', 'CANCELLED'] as const;
const MILESTONE_STATUS_BY_INDEX = [
  'UNFUNDED',
  'FUNDED',
  'FINANCE_REQUESTED',
  'FINANCED',
  'SUBMITTED',
  'VERIFIED',
  'DISPUTED',
  'SETTLED',
  'REFUNDED',
] as const;

/** The bindings return a `#[contracttype]` enum as its numeric discriminant. */
function statusName(from: readonly string[], value: unknown): string | null {
  const index = typeof value === 'number' ? value : Number(value);
  return from[index] ?? null;
}

function compare(field: string, chain: string | null, database: string | null): FieldComparison {
  return { field, chain, database, matches: chain === database };
}

@Injectable()
export class ReconcileService {
  private readonly client: Client;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ApiConfig,
  ) {
    this.client = new Client({
      contractId: config.stellar.contractId,
      networkPassphrase: config.stellar.networkPassphrase,
      rpcUrl: config.stellar.rpcUrl,
    });
  }

  /** Read order state straight from the contract and diff it against the row. */
  async reconcileOrder(orderId: bigint): Promise<ReconciliationResult> {
    const row = await this.prisma.orderReadModel.findUnique({
      where: {
        order_identity: {
          network: this.config.stellar.network,
          contractId: this.config.stellar.contractId,
          orderId,
        },
      },
    });

    const simulated = await this.client.get_order({ order_id: orderId });
    const result = simulated.result;
    const chain = result.isOk() ? (result.unwrap() as unknown as Record<string, unknown>) : null;

    const fields: FieldComparison[] = [];
    if (chain !== null && row !== null) {
      fields.push(
        compare('buyer', String(chain.buyer), row.buyer),
        compare('supplier', String(chain.supplier), row.supplier),
        compare('attestor', String(chain.attestor), row.attestor),
        compare('resolver', String(chain.resolver), row.resolver),
        compare('asset', String(chain.asset), row.asset),
        compare('status', statusName(ORDER_STATUS_BY_INDEX, chain.status), row.status),
      );
    }

    return {
      entity: 'order',
      id: orderId.toString(),
      presentOnChain: chain !== null,
      presentInDatabase: row !== null,
      reconciled: chain !== null && row !== null && fields.every((field) => field.matches),
      fields,
      checkedAt: new Date().toISOString(),
    };
  }

  /** Same idea for a milestone, including the escrow figure. */
  async reconcileMilestone(milestoneId: bigint): Promise<ReconciliationResult> {
    const row = await this.prisma.milestoneReadModel.findUnique({
      where: {
        milestone_identity: {
          network: this.config.stellar.network,
          contractId: this.config.stellar.contractId,
          milestoneId,
        },
      },
    });

    const simulated = await this.client.get_milestone({ milestone_id: milestoneId });
    const result = simulated.result;
    const chain = result.isOk() ? (result.unwrap() as unknown as Record<string, unknown>) : null;

    const fields: FieldComparison[] = [];
    if (chain !== null && row !== null) {
      fields.push(
        compare('orderId', String(chain.order_id), row.orderId.toString()),
        compare('amount', String(chain.amount), row.amount.toFixed(0)),
        compare('fundedAmount', String(chain.funded_amount), row.fundedAmount.toFixed(0)),
        compare('status', statusName(MILESTONE_STATUS_BY_INDEX, chain.status), row.status),
      );
    }

    return {
      entity: 'milestone',
      id: milestoneId.toString(),
      presentOnChain: chain !== null,
      presentInDatabase: row !== null,
      reconciled: chain !== null && row !== null && fields.every((field) => field.matches),
      fields,
      checkedAt: new Date().toISOString(),
    };
  }

  /** How many orders the contract knows about, for a coverage check. */
  async chainOrderCount(): Promise<bigint> {
    const simulated = await this.client.order_count();
    return simulated.result;
  }
}

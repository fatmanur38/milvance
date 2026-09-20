'use client';

import Link from 'next/link';

import { ApiError, describeApiError } from '@/lib/api/client';
import { useOrder } from '@/lib/api/queries';
import { orderActions } from '@/lib/domain/actions';
import { orderRolesFor, ROLE_LABELS } from '@/lib/domain/roles';
import { ORDER_STATUS_LABELS } from '@/lib/domain/status';
import { useWallet } from '@/lib/wallet/provider';

import {
  Address,
  Badge,
  Button,
  Card,
  EmptyState,
  ExplorerLink,
  Loading,
  Notice,
  Technical,
} from '../ui/primitives';
import { WalletNotice } from '../wallet/wallet-chip';
import { MilestoneCard } from './milestone-card';
import { AcceptOrderAction, CancelOrderAction, CreateMilestoneForm } from './order-forms';

export function OrderDetail({ orderId }: { orderId: string }) {
  const { state } = useWallet();
  const wallet = state.address;
  const order = useOrder(orderId);

  if (order.isPending) return <Loading label="Loading order…" />;
  if (order.isError) {
    const notFound = order.error instanceof ApiError && order.error.kind === 'not-found';
    return (
      <Notice
        tone={notFound ? 'attention' : 'danger'}
        title={notFound ? `Order #${orderId} is not in the workspace` : 'Could not load this order'}
        action={
          <Button variant="secondary" className="w-fit" onClick={() => void order.refetch()}>
            Try again
          </Button>
        }
      >
        {describeApiError(order.error)}
      </Notice>
    );
  }

  const data = order.data;
  const roles = orderRolesFor(wallet, data);
  const actions = orderActions(wallet, data);

  return (
    <div className="flex flex-col gap-6">
      <Link href="/app/orders" className="text-sm text-muted hover:text-foreground">
        ← Orders
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Order #{data.orderId}</h1>
          <p className="text-sm text-muted">
            {data.milestones.length} milestone{data.milestones.length === 1 ? '' : 's'} · created{' '}
            {new Date(data.createdAt).toLocaleDateString()}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge
            tone={
              data.status === 'ACTIVE'
                ? 'progress'
                : data.status === 'COMPLETED'
                  ? 'success'
                  : 'neutral'
            }
          >
            {ORDER_STATUS_LABELS[data.status]}
          </Badge>
          {roles.map((role) => (
            <Badge key={role} tone="progress">
              You: {ROLE_LABELS[role]}
            </Badge>
          ))}
        </div>
      </div>

      <WalletNotice />
      {wallet && roles.length === 0 && (
        <Notice>
          This wallet has no role on this order. You can read it — it is public on Stellar — but
          only its buyer, supplier, attestor and resolver can act on it. Funders can offer working
          capital when the supplier asks for it.
        </Notice>
      )}

      <Card aria-label="Parties">
        <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          {(['buyer', 'supplier', 'attestor', 'resolver'] as const).map((role) => (
            <div key={role}>
              <dt className="text-xs uppercase tracking-wide text-muted">{ROLE_LABELS[role]}</dt>
              <dd>
                <Address value={data[role]} you={data[role] === wallet} />
              </dd>
            </div>
          ))}
        </dl>
      </Card>

      {actions.includes('accept-order') && <AcceptOrderAction order={data} />}
      {actions.includes('create-milestone') && <CreateMilestoneForm order={data} />}
      {actions.includes('cancel-order') && <CancelOrderAction order={data} />}
      {data.status === 'CREATED' && !roles.includes('buyer') && !roles.includes('supplier') && (
        <Notice>This order is still a draft: the supplier has not accepted it yet.</Notice>
      )}

      {data.milestones.length === 0 ? (
        <EmptyState title="No milestones yet">
          {roles.includes('buyer')
            ? 'Add the first milestone above. Each milestone is a payment you protect separately.'
            : 'The buyer has not added milestones to this order yet.'}
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-4">
          {data.milestones.map((milestone) => (
            <MilestoneCard
              key={milestone.milestoneId}
              order={data}
              milestone={milestone}
              wallet={wallet}
            />
          ))}
        </div>
      )}

      <Technical>
        <span>Contract {data.provenance.contractId}</span>
        <span>
          Read model through ledger {data.provenance.lastLedger} · order created in ledger{' '}
          {data.createdLedger}
        </span>
        <span>Settlement asset {data.settlementAsset}</span>
        <ExplorerLink hash={data.createdTxHash}>Order creation transaction</ExplorerLink>
      </Technical>
    </div>
  );
}

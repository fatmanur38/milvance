'use client';

import Link from 'next/link';
import { useState } from 'react';

import { describeApiError } from '@/lib/api/client';
import { useOrders } from '@/lib/api/queries';
import type { OrderWithMilestones } from '@/lib/api/schemas';
import { formatUsdc } from '@/lib/domain/amounts';
import { orderRolesFor, ROLE_LABELS, shortAddress, type OrderRole } from '@/lib/domain/roles';
import { ORDER_STATUS_LABELS } from '@/lib/domain/status';

import { Badge, Button, Card, EmptyState, Loading, Notice } from '../ui/primitives';

type Filter = 'all' | OrderRole;

/** Sum of milestone payments. Buyer-side figure only — it never includes funder money. */
function orderValue(order: OrderWithMilestones): string {
  return order.milestones
    .reduce((total, milestone) => total + BigInt(milestone.amount), 0n)
    .toString();
}

export function OrderList({ wallet }: { wallet: string }) {
  const orders = useOrders(wallet);
  const [filter, setFilter] = useState<Filter>('all');

  if (orders.isPending) return <Loading label="Loading your orders…" />;
  if (orders.isError) {
    return (
      <Notice
        tone="danger"
        title="Could not load your orders"
        action={
          <Button variant="secondary" className="w-fit" onClick={() => void orders.refetch()}>
            Try again
          </Button>
        }
      >
        {describeApiError(orders.error)}
      </Notice>
    );
  }

  const all = orders.data.orders;
  if (all.length === 0) {
    return (
      <EmptyState title="No orders yet">
        This wallet is not a buyer, supplier, attestor or resolver on any order. Create one as a
        buyer below, or ask a buyer to add you. Funders can find opportunities under Funding.
      </EmptyState>
    );
  }

  // A presentation filter only — it hides rows, it grants nothing.
  const shown =
    filter === 'all' ? all : all.filter((order) => orderRolesFor(wallet, order).includes(filter));
  const available = (['buyer', 'supplier', 'attestor', 'resolver'] as const).filter((role) =>
    all.some((order) => orderRolesFor(wallet, order).includes(role)),
  );

  return (
    <div className="flex flex-col gap-4">
      {available.length > 1 && (
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Filter by your role">
          {(['all', ...available] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={filter === value}
              onClick={() => setFilter(value)}
              className={`rounded-md px-3 py-1 text-sm ${filter === value ? 'bg-surface font-medium shadow-card' : 'text-muted'}`}
            >
              {value === 'all' ? 'All' : `As ${ROLE_LABELS[value].toLowerCase()}`}
            </button>
          ))}
        </div>
      )}
      <div className="grid gap-3">
        {shown.map((order) => (
          <Link key={order.orderId} href={`/app/orders/${order.orderId}`} className="block">
            <Card
              as="article"
              className="flex flex-wrap items-center justify-between gap-3 hover:border-accent"
            >
              <div className="flex flex-col gap-1">
                <span className="font-medium">Order #{order.orderId}</span>
                <span className="text-xs text-muted">
                  Supplier {shortAddress(order.supplier)} · {order.milestones.length} milestone
                  {order.milestones.length === 1 ? '' : 's'}
                  {order.milestones.length > 0 &&
                    ` · ${formatUsdc(orderValue(order))} in milestone payments`}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {orderRolesFor(wallet, order).map((role) => (
                  <Badge key={role} tone="progress">
                    {ROLE_LABELS[role]}
                  </Badge>
                ))}
                <Badge>{ORDER_STATUS_LABELS[order.status]}</Badge>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}

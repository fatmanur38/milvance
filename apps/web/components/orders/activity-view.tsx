'use client';

import Link from 'next/link';

import { describeApiError } from '@/lib/api/client';
import { useActivity } from '@/lib/api/queries';
import { eventLabel } from '@/lib/domain/status';

import { EmptyState, ExplorerLink, Loading, Notice } from '../ui/primitives';

function orderIdOf(fields: unknown): string | null {
  if (typeof fields === 'object' && fields !== null && 'order_id' in fields) {
    const value = (fields as { order_id: unknown }).order_id;
    return typeof value === 'string' && /^\d+$/.test(value) ? value : null;
  }
  return null;
}

/** Contract events, newest first, straight from the indexed chain history. */
export function ActivityView() {
  const activity = useActivity();
  if (activity.isPending) return <Loading />;
  if (activity.isError) return <Notice tone="danger">{describeApiError(activity.error)}</Notice>;
  if (activity.data.activity.length === 0) {
    return <EmptyState title="No contract activity yet" />;
  }
  return (
    <ol className="flex flex-col divide-y divide-border rounded-xl border border-border bg-surface">
      {activity.data.activity.map((item) => {
        const orderId = orderIdOf(item.fields);
        return (
          <li
            key={item.eventId}
            className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm"
          >
            <div className="flex flex-col">
              <span className="font-medium">{eventLabel(item.eventName)}</span>
              <span className="text-xs text-muted">
                {new Date(item.ledgerClosedAt).toLocaleString()} · ledger {item.ledger}
                {orderId && (
                  <>
                    {' · '}
                    <Link className="underline" href={`/app/orders/${orderId}`}>
                      Order #{orderId}
                    </Link>
                  </>
                )}
              </span>
            </div>
            <ExplorerLink hash={item.txHash} />
          </li>
        );
      })}
    </ol>
  );
}

'use client';

import Link from 'next/link';

import { describeApiError } from '@/lib/api/client';
import { useOpportunities, useOrders } from '@/lib/api/queries';
import { attentionItems } from '@/lib/domain/attention';
import { orderRolesFor, ROLE_LABELS, type OrderRole } from '@/lib/domain/roles';
import { useWallet } from '@/lib/wallet/provider';

import { Card, EmptyState, Loading, Notice } from '../ui/primitives';
import { WalletNotice } from '../wallet/wallet-chip';

function Explainer() {
  return (
    <Card aria-label="How Milvance works" className="grid gap-4 text-sm md:grid-cols-3">
      <div>
        <p className="font-semibold text-protected">Buyer money is protected</p>
        <p className="text-muted">
          The buyer locks each milestone payment on Stellar. It is not paid to the supplier early.
        </p>
      </div>
      <div>
        <p className="font-semibold text-capital">Funder money is working capital</p>
        <p className="text-muted">
          A separate funder advances its own money to the supplier now, and is repaid first on
          verification.
        </p>
      </div>
      <div>
        <p className="font-semibold">Local money at the edge</p>
        <p className="text-muted">
          The supplier converts the advance to TRY for materials and wages. Humans verify evidence;
          Soroban enforces the payout.
        </p>
      </div>
    </Card>
  );
}

export function OverviewView() {
  const { state } = useWallet();
  const wallet = state.address;
  const orders = useOrders(wallet);
  const opportunities = useOpportunities();

  const counts = new Map<OrderRole, number>();
  for (const order of orders.data?.orders ?? []) {
    for (const role of orderRolesFor(wallet, order)) counts.set(role, (counts.get(role) ?? 0) + 1);
  }
  const attention = attentionItems(wallet, orders.data?.orders ?? []);
  const openRequests = (opportunities.data?.opportunities ?? []).filter(
    (item) => new Date(item.expiresAt).getTime() > Date.now(),
  ).length;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Overview</h1>
        <p className="text-sm text-muted">
          Protected production payments and working capital, milestone by milestone.
        </p>
      </div>
      <WalletNotice />
      <Explainer />

      {wallet &&
        (orders.isPending ? (
          <Loading label="Loading your workspace…" />
        ) : orders.isError ? (
          <Notice tone="danger" title="Could not load your orders">
            {describeApiError(orders.error)}
          </Notice>
        ) : (
          <>
            <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Your roles">
              {(['buyer', 'supplier', 'attestor', 'resolver'] as const).map((role) => (
                <Card key={role} className="flex flex-col gap-1">
                  <span className="text-xs uppercase tracking-wide text-muted">
                    As {ROLE_LABELS[role].toLowerCase()}
                  </span>
                  <span className="text-2xl font-semibold">{counts.get(role) ?? 0}</span>
                  <span className="text-xs text-muted">orders</span>
                </Card>
              ))}
            </section>

            <section className="flex flex-col gap-3" aria-label="Needs your attention">
              <h2 className="text-lg font-semibold">Needs your attention</h2>
              {attention.length === 0 ? (
                <EmptyState title="Nothing is waiting on you">
                  Orders where you are buyer, supplier, attestor or resolver will surface here when
                  they need your action.
                </EmptyState>
              ) : (
                <ul className="flex flex-col gap-2">
                  {attention.map((item) => (
                    <li key={`${item.orderId}-${item.milestoneId ?? 'order'}-${item.role}`}>
                      <Link
                        href={`/app/orders/${item.orderId}${item.milestoneId ? `#milestone-${item.milestoneId}` : ''}`}
                        className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-3 text-sm hover:border-accent"
                      >
                        <span>
                          <span className="text-muted">Order #{item.orderId} · </span>
                          {item.title}
                        </span>
                        <span className="text-xs text-muted">
                          as {ROLE_LABELS[item.role].toLowerCase()}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        ))}

      <Card className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm">
          <p className="font-medium">Funding opportunities</p>
          <p className="text-muted">
            {opportunities.isError
              ? 'Unavailable right now.'
              : `${openRequests} open working-capital request${openRequests === 1 ? '' : 's'} against protected milestones.`}
          </p>
        </div>
        <Link
          href="/app/funding"
          className="text-sm font-medium text-accent underline underline-offset-2"
        >
          View funding
        </Link>
      </Card>
    </div>
  );
}

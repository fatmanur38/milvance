'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { useOrders } from '@/lib/api/queries';
import type { OrderWithMilestones } from '@/lib/api/schemas';
import { DEFAULT_TEMPLATE_ID, TRADE_TEMPLATES, templateById } from '@/lib/demo/templates';
import { orderRolesFor, ROLE_LABELS } from '@/lib/domain/roles';
import { ORDER_STATUS_LABELS } from '@/lib/domain/status';
import { testnetDeployment } from '@/lib/wallet/config';
import { useWallet } from '@/lib/wallet/provider';
import { CreateOrderForm } from '../orders/order-forms';
import { Badge, Card, EmptyState, Loading, Notice } from '../ui/primitives';
import { ParticipantConsent } from './participant-consent';
import { useDemoRuns } from './use-demo-runs';

/**
 * Trade Lab: a fast way to set up a REAL trade.
 *
 * Nothing here is a simulator. A template is suggested wording and suggested
 * amounts; the buyer still signs `create_order` with their own wallet, the
 * supplier still accepts with theirs, and every number shown afterwards comes
 * back from the contract through the indexer. The lab's whole job is to remove
 * the fumbling around a live demo: pick a shape of trade, invite the other
 * side, see whose turn it is.
 */
export function TradeLab() {
  const { state } = useWallet();
  const wallet = state.address;
  const orders = useOrders(wallet);
  const { runs, attach } = useDemoRuns();
  const [templateId, setTemplateId] = useState<string>(DEFAULT_TEMPLATE_ID);
  const template = templateById(templateId) ?? TRADE_TEMPLATES[0];

  const all = useMemo(() => orders.data?.orders ?? [], [orders.data]);
  // Newest first: the API returns ascending chain ids, and a demo cares about
  // the trade that was just created.
  const mine = useMemo(
    () =>
      all
        .filter((order) => orderRolesFor(wallet, order).includes('buyer'))
        .slice()
        .sort((left, right) => (BigInt(right.orderId) > BigInt(left.orderId) ? 1 : -1)),
    [all, wallet],
  );
  const newest = mine[0];
  const reuse = partiesOf(newest);
  const unlabelled =
    newest !== undefined && !runs.some((run) => run.orderId === newest.orderId) ? newest : null;
  useEffect(() => {
    if (
      unlabelled !== null &&
      unlabelled.status === 'CREATED' &&
      unlabelled.milestones.length === 0
    ) {
      attach(unlabelled.orderId, templateId);
    }
  }, [attach, templateId, unlabelled]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Trade Lab</h1>
        <p className="mt-1 text-sm text-muted">
          Set up a real trade quickly, invite the other side, and watch it move through Stellar.
        </p>
      </div>

      <Notice tone="attention" title="Stellar Testnet only">
        Every trade you start here is a real transaction on Stellar Testnet, signed by your wallet,
        using test USDC from the approved Testnet issuer. There is no simulated mode and no
        shortcut: the lab cannot move money, and the contract at{' '}
        <span className="font-mono text-xs">{short(testnetDeployment.contractId)}</span> decides
        everything. Keep Freighter on Testnet.
      </Notice>

      <Card className="flex flex-col gap-4">
        <div>
          <h2 className="text-lg font-semibold">1. Pick the shape of the trade</h2>
          <p className="text-sm text-muted">
            A template suggests stages and amounts. It signs nothing and writes nothing to Stellar.
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {TRADE_TEMPLATES.map((candidate) => {
            const selected = candidate.id === template?.id;
            return (
              <button
                key={candidate.id}
                type="button"
                onClick={() => setTemplateId(candidate.id)}
                aria-pressed={selected}
                className={`rounded-lg border p-4 text-left ${
                  selected ? 'border-protected bg-protected-soft' : 'border-border bg-surface'
                }`}
              >
                <p className="font-medium">{candidate.name}</p>
                <p className="mt-1 text-sm text-muted">{candidate.summary}</p>
                <p className="mt-2 text-xs text-muted">
                  {candidate.milestones.length} milestones · about {candidate.minutes} minutes
                </p>
              </button>
            );
          })}
        </div>
        {template !== undefined && (
          <div className="rounded-lg border border-border p-4 text-sm">
            <p className="text-muted">{template.story}</p>
            <ul className="mt-3 flex flex-col gap-1">
              {template.milestones.map((milestone, index) => (
                <li key={milestone.stage}>
                  <span className="font-medium">
                    {index + 1}. {milestone.stage}
                  </span>{' '}
                  — {milestone.amount} USDC protected. Evidence: {milestone.evidence}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-muted">
              Financing example: the supplier asks for {template.financing.principal} USDC against
              milestone {template.financing.milestone}, repaying {template.financing.repayment} USDC
              out of the protected amount when it is verified. The funder&rsquo;s money goes
              straight to the supplier; the buyer&rsquo;s protected payment never moves until
              settlement.
            </p>
          </div>
        )}
      </Card>

      <Card className="flex flex-col gap-4">
        <div>
          <h2 className="text-lg font-semibold">2. Create the trade</h2>
          <p className="text-sm text-muted">
            You sign this as the buyer. No money moves — it records who the four parties are.
          </p>
        </div>
        {wallet === undefined ? (
          <Notice tone="attention" title="Connect your wallet first">
            The trade is created by your wallet, and you become its buyer.
          </Notice>
        ) : (
          <>
            {reuse !== null && (
              <p className="text-xs text-muted">
                Suggested from your last trade, so a repeat demo does not mean retyping three
                addresses. Check them before signing.
              </p>
            )}
            <CreateOrderForm {...(reuse !== null ? { initialParties: reuse } : {})} />
          </>
        )}
      </Card>

      <Card className="flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold">3. Your trades</h2>
          <Link className="text-sm underline" href="/app/orders">
            All orders
          </Link>
        </div>
        {wallet === undefined ? (
          <p className="text-sm text-muted">Connect a wallet to see the trades it is part of.</p>
        ) : orders.isPending ? (
          <Loading label="Loading trades…" />
        ) : all.length === 0 ? (
          <EmptyState title="No trades yet">
            Create one above, or open an invite someone shared with you.
          </EmptyState>
        ) : (
          <ul className="flex flex-col gap-2">
            {all.map((order) => {
              const roles = orderRolesFor(wallet, order);
              const run = runs.find((candidate) => candidate.orderId === order.orderId);
              const runTemplate = templateById(run?.templateId ?? null);
              return (
                <li
                  key={order.orderId}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3 text-sm"
                >
                  <div>
                    <p className="font-medium">
                      Trade #{order.orderId}
                      {runTemplate !== null ? ` · ${runTemplate.name}` : ''}
                    </p>
                    <p className="text-xs text-muted">
                      {roles.map((role) => ROLE_LABELS[role]).join(' and ') || 'Not a party'} ·{' '}
                      {order.milestones.length} milestone{order.milestones.length === 1 ? '' : 's'}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <Badge tone={order.status === 'COMPLETED' ? 'success' : 'progress'}>
                      {ORDER_STATUS_LABELS[order.status]}
                    </Badge>
                    <Link className="underline" href={`/app/trade-lab/${order.orderId}`}>
                      Open run
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <ParticipantConsent wallet={wallet} />
    </div>
  );
}

function partiesOf(
  order: OrderWithMilestones | undefined,
): { supplier: string; attestor: string; resolver: string } | null {
  if (order === undefined) return null;
  return { supplier: order.supplier, attestor: order.attestor, resolver: order.resolver };
}

function short(value: string): string {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

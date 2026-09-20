'use client';

import Link from 'next/link';
import { useState } from 'react';

import { describeApiError } from '@/lib/api/client';
import { useActivity, useAllOrders } from '@/lib/api/queries';
import { buildTour, pickTourOrder, tourIsTellable, type TourStep } from '@/lib/demo/tour';
import { formatUsdcUnits } from '@/lib/domain/amounts';
import { testnetDeployment } from '@/lib/wallet/config';
import { Badge, Button, Card, ExplorerLink, Loading, Notice } from '../ui/primitives';
import { TradeFlow } from './trade-flow';

/**
 * The guided tour: what a judge sees when they have four minutes and no wallet.
 *
 * Every step is a real MilvanceCore event with the transaction that produced
 * it, so the page can be checked line by line against a block explorer. There
 * is no simulated mode to switch into — if the chain has no history, this page
 * says so rather than inventing some.
 */
export function GuidedTour() {
  // No participant filter: the tour is public history, not anyone's workspace.
  const orders = useAllOrders();
  const activity = useActivity();
  const [index, setIndex] = useState(0);

  if (orders.isPending || activity.isPending) {
    return <Loading label="Reading the trade from Stellar…" />;
  }
  if (orders.isError || activity.isError) {
    const error = orders.error ?? activity.error;
    return (
      <Notice
        tone="danger"
        title="Could not load the trade"
        action={
          <Button
            variant="secondary"
            className="w-fit"
            onClick={() => {
              void orders.refetch();
              void activity.refetch();
            }}
          >
            Try again
          </Button>
        }
      >
        {describeApiError(error)}
      </Notice>
    );
  }

  const order = pickTourOrder(orders.data?.orders ?? []);
  const steps = order === null ? [] : buildTour(order, activity.data?.activity ?? []);

  if (order === null || !tourIsTellable(steps)) {
    return (
      <Notice tone="attention" title="No finished trade to walk through yet">
        This tour narrates real transactions, so it has nothing to show until a trade has been run
        on this deployment. Start one in{' '}
        <Link className="underline" href="/app/trade-lab">
          Trade Lab
        </Link>{' '}
        and it will appear here.
      </Notice>
    );
  }

  const step = steps[Math.min(index, steps.length - 1)];

  return (
    <div className="flex flex-col gap-6">
      {/* The animation first. The distinction it shows is the product. */}
      <TradeFlow steps={steps} index={Math.min(index, steps.length - 1)} onIndexChange={setIndex} />

      {step !== undefined && (
        <StepDetail step={step} number={Math.min(index, steps.length - 1) + 1} />
      )}

      <details className="rounded-xl border border-border p-4">
        <summary className="cursor-pointer text-sm font-medium">
          All {steps.length} transactions of trade #{order.orderId}
        </summary>
        <ol className="mt-3 flex flex-col gap-1">
          {steps.map((candidate, position) => (
            <li key={candidate.id}>
              <button
                type="button"
                onClick={() => setIndex(position)}
                aria-current={position === index}
                className={`flex w-full flex-wrap items-baseline gap-2 rounded-lg px-2 py-1.5 text-left text-sm ${
                  position === index ? 'bg-foreground/[0.06]' : 'hover:bg-foreground/[0.03]'
                }`}
              >
                <span className="w-5 shrink-0 tabular-nums text-xs text-muted">{position + 1}</span>
                <span className="font-medium">{candidate.title}</span>
                {candidate.amount !== null && (
                  <span className="tabular-nums text-xs text-muted">
                    {formatUsdcUnits(candidate.amount)} USDC
                  </span>
                )}
              </button>
            </li>
          ))}
        </ol>
      </details>

      <Notice tone="attention" title="This is real history, not a simulation">
        Every step happened on Stellar Testnet, signed by a wallet, and links to the transaction
        that produced it. Nothing is scripted, and there is no mode that makes it up — follow a link
        and you are reading the ledger. Contract{' '}
        <span className="font-mono text-xs">{short(testnetDeployment.contractId)}</span>.
      </Notice>

      <Card className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Want to make history instead of reading it?</h2>
        <p className="text-sm text-muted">
          Everything above was produced by the same product you can use. Connect a Freighter wallet
          on Stellar Testnet and start a trade — it takes one transaction and moves no money.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link
            className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background"
            href="/app/trade-lab"
          >
            Open Trade Lab
          </Link>
          <Link className="rounded-lg border border-border px-4 py-2 text-sm" href="/app/orders">
            Browse every trade
          </Link>
          <Link className="rounded-lg border border-border px-4 py-2 text-sm" href="/app/metrics">
            See the numbers
          </Link>
        </div>
      </Card>
    </div>
  );
}

const THEME_LABELS: Record<TourStep['theme'], string> = {
  setup: 'Setting up',
  'buyer-protection': 'Buyer protection',
  'working-capital': 'Working capital',
  'local-money': 'Local money',
  verification: 'Verification',
  settlement: 'Settlement',
  dispute: 'Dispute',
};

/**
 * The active step's words, alongside the frame the animation is showing.
 *
 * Only one at a time. The full list is a disclosure below, because a reader
 * who wanted to read twelve paragraphs would not have needed the picture.
 */
function StepDetail({ step, number }: { step: TourStep; number: number }) {
  return (
    <Card className="flex flex-col gap-3" data-testid="tour-step">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border text-xs tabular-nums">
          {number}
        </span>
        <h3 className="text-base font-semibold">{step.title}</h3>
        <Badge tone="neutral">{THEME_LABELS[step.theme]}</Badge>
        <span className="text-xs text-muted">{step.actor} signed this</span>
      </div>

      <p className="text-sm">{step.detail}</p>

      {step.lesson !== undefined && (
        <p className="rounded-lg border border-border bg-foreground/[0.03] p-3 text-sm">
          {step.lesson}
        </p>
      )}

      <p className="text-xs text-muted">
        Ledger {step.ledger} · {new Date(step.at).toISOString().replace('T', ' ').slice(0, 16)} UTC
        · <ExplorerLink hash={step.txHash}>check it on Stellar</ExplorerLink>
      </p>
    </Card>
  );
}

function short(value: string): string {
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

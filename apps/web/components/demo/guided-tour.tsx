'use client';

import Link from 'next/link';

import { describeApiError } from '@/lib/api/client';
import { useActivity, useAllOrders } from '@/lib/api/queries';
import { buildTour, pickTourOrder, tourIsTellable, type TourStep } from '@/lib/demo/tour';
import { formatUsdcUnits } from '@/lib/domain/amounts';
import { testnetDeployment } from '@/lib/wallet/config';
import { Badge, Button, Card, ExplorerLink, Loading, Notice } from '../ui/primitives';

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

  return (
    <div className="flex flex-col gap-6">
      <Notice tone="attention" title="This is real history, not a simulation">
        Every step below happened on Stellar Testnet, signed by a wallet, and is linked to the
        transaction that produced it. Nothing here is scripted, and there is no mode that makes it
        up — if you follow a link, you are reading the ledger.
      </Notice>

      <Card className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold">Trade #{order.orderId}</h2>
          <span className="text-xs text-muted">
            {steps.length} transactions · contract{' '}
            <span className="font-mono">{short(testnetDeployment.contractId)}</span>
          </span>
        </div>
        <p className="text-sm text-muted">
          A buyer protects a milestone payment. A funder advances working capital against it. The
          contract repays the funder first when the work is verified. One stage was disputed and
          refunded, which is included on purpose — the honest path matters more than the happy one.
        </p>
      </Card>

      <ol className="flex flex-col gap-4">
        {steps.map((step, index) => (
          <li key={step.id}>
            <Step step={step} number={index + 1} />
          </li>
        ))}
      </ol>

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

/** How to read a step's amount, so the two pools never blur into one figure. */
const AMOUNT_LABELS: Record<NonNullable<TourStep['amountMeans']>, string> = {
  protected: 'protected by the buyer',
  advanced: 'advanced by the funder, from their own money',
  repaid: 'released from escrow',
  'paid-out': 'paid to the supplier',
  refunded: 'returned to the buyer',
};

function Step({ step, number }: { step: TourStep; number: number }) {
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

      {step.amount !== null && (
        <p className="text-sm">
          <span className="text-xl font-semibold tabular-nums">
            {formatUsdcUnits(step.amount)} USDC
          </span>
          {step.amountMeans !== null && (
            <span className="text-muted"> — {AMOUNT_LABELS[step.amountMeans]}</span>
          )}
        </p>
      )}

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

'use client';

import Link from 'next/link';

import { ApiError, describeApiError } from '@/lib/api/client';
import { useMilestoneFinance, useOrder } from '@/lib/api/queries';
import type { Milestone, OrderWithMilestones } from '@/lib/api/schemas';
import { demoProgress, nextActionHref, type DemoStep } from '@/lib/demo/progress';
import { restartGuidance } from '@/lib/demo/session';
import { templateById, type TradeTemplate } from '@/lib/demo/templates';
import { milestoneActions, orderActions } from '@/lib/domain/actions';
import { orderRolesFor, ROLE_LABELS } from '@/lib/domain/roles';
import { milestoneTitle, ORDER_STATUS_LABELS } from '@/lib/domain/status';
import { useWallet } from '@/lib/wallet/provider';
import { MilestoneCard } from '../orders/milestone-card';
import { CreateMilestoneForm } from '../orders/order-forms';
import { Badge, Button, Card, ExplorerLink, Loading, Notice } from '../ui/primitives';
import { useDemoRuns } from './use-demo-runs';
import { InvitePanel } from './invite-panel';

/**
 * One demo run: a real trade, seen through the template that inspired it.
 *
 * Everything financial on this page is the ordinary workspace — the milestone
 * card below is the same component the order page renders, with the same
 * wallet-signed actions and the same money pools. The lab adds only what a
 * demo needs: where the trade has got to, who has to act next, the invites to
 * get them here, and the stage names the chain does not store.
 */
export function RunView({ orderId }: { orderId: string }) {
  const { state } = useWallet();
  const wallet = state.address;
  const order = useOrder(orderId);
  const { runs, forget } = useDemoRuns();

  if (order.isPending) return <Loading label="Loading the trade…" />;
  if (order.isError) {
    const notFound = order.error instanceof ApiError && order.error.kind === 'not-found';
    return (
      <Notice
        tone={notFound ? 'attention' : 'danger'}
        title={notFound ? `Trade #${orderId} is not in the workspace` : 'Could not load this trade'}
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
  const template = templateById(runs.find((run) => run.orderId === orderId)?.templateId ?? null);
  const active = activeMilestone(data);

  return (
    <div className="flex flex-col gap-6">
      <Link href="/app/trade-lab" className="text-sm text-muted hover:text-foreground">
        ← Trade Lab
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Trade #{data.orderId}</h1>
          <p className="text-sm text-muted">
            {template?.name ?? 'No template recorded in this browser'} ·{' '}
            {ORDER_STATUS_LABELS[data.status]}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge tone={data.status === 'COMPLETED' ? 'success' : 'progress'}>
            {ORDER_STATUS_LABELS[data.status]}
          </Badge>
          <Link className="text-sm underline" href={`/app/orders/${data.orderId}`}>
            Full workspace
          </Link>
        </div>
      </div>

      <RunProgress order={data} milestone={active} wallet={wallet} />

      {template !== null && data.status === 'CREATED' && (
        <TemplateStages order={data} template={template} wallet={wallet} />
      )}

      {active !== null && (
        <div className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">
            {milestoneTitle(active.index)}
            {template?.milestones[active.index] !== undefined
              ? ` · ${template.milestones[active.index]?.stage}`
              : ''}
          </h2>
          <p className="text-sm text-muted">
            The card below is the workspace itself. Every button on it builds a real transaction
            your wallet signs.
          </p>
          <MilestoneCard order={data} milestone={active} wallet={wallet} />
        </div>
      )}

      {active !== null && needsEvidence(active.status) && (
        <Card className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">Evidence for a demo</h2>
          <p className="text-sm text-muted">
            The supplier submits a document for this milestone. If you need one to hand, this sample
            contains nothing real and nothing personal.
          </p>
          <a className="text-sm underline" href="/demo/sample-qc-report.txt" download>
            Download a sample QC report
          </a>
          <p className="text-xs text-muted">
            Your browser hashes the file and the bytes stay off-chain — only the SHA-256 fingerprint
            is written to Stellar. The attestor still reads the document and decides for themselves;
            Stellar cannot inspect goods.
          </p>
        </Card>
      )}

      <InvitePanel
        order={data}
        templateId={template?.id ?? null}
        milestoneId={active?.milestoneId ?? null}
      />

      <TradeRecord order={data} />

      <Card className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Running it again</h2>
        <p className="text-sm text-muted">{restartGuidance(data).reason}</p>
        <div className="flex flex-wrap gap-3">
          <Link
            className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background"
            href="/app/trade-lab"
          >
            Start a new trade
          </Link>
          <Button variant="secondary" onClick={() => forget(data.orderId)}>
            Remove from this browser
          </Button>
        </div>
        <p className="text-xs text-muted">
          Removing it clears the template note kept in this browser. The trade itself, and
          everything that happened to it, stays on Stellar exactly as it is.
        </p>
      </Card>
    </div>
  );
}

/** States where a supplier still has evidence to submit. */
function needsEvidence(status: Milestone['status']): boolean {
  return status === 'FUNDED' || status === 'FINANCE_REQUESTED' || status === 'FINANCED';
}

/** The milestone a demo is currently about: the first unfinished one. */
function activeMilestone(order: OrderWithMilestones): Milestone | null {
  const live = order.milestones.find(
    (milestone) => milestone.status !== 'SETTLED' && milestone.status !== 'REFUNDED',
  );
  return live ?? order.milestones.at(-1) ?? null;
}

const STEP_MARK: Record<DemoStep['state'], string> = {
  done: '✓',
  now: '→',
  later: '·',
  skipped: '—',
};

function RunProgress({
  order,
  milestone,
  wallet,
}: {
  order: OrderWithMilestones;
  milestone: Milestone | null;
  wallet: string | undefined;
}) {
  const finance = useMilestoneFinance(milestone?.milestoneId ?? '0', milestone !== null);
  const index = milestone === null ? 0 : order.milestones.indexOf(milestone);
  const progress = demoProgress(order, index, finance.data);
  const roles = orderRolesFor(wallet, order);
  const next = nextStepFor(order, milestone, wallet, finance.data);

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">Where this trade has got to</h2>
        <span className="text-sm text-muted">
          {progress.done} of {progress.total} steps
        </span>
      </div>
      <ol className="grid gap-1 text-sm md:grid-cols-2">
        {progress.steps.map((step) => (
          <li
            key={step.id}
            className={
              step.state === 'done'
                ? 'text-foreground'
                : step.state === 'now'
                  ? 'font-medium text-protected'
                  : 'text-muted'
            }
          >
            <span aria-hidden className="mr-2 font-mono">
              {STEP_MARK[step.state]}
            </span>
            {step.label}
            <span className="ml-1 text-xs text-muted">({step.who})</span>
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted">
        Read from the contract's own events, through the indexer. Nothing here can be ticked by
        hand.
      </p>
      {next === null ? (
        <Notice tone="neutral" title="Nothing for this wallet to do right now">
          {wallet === undefined
            ? 'Connect a wallet to see what it can do on this trade.'
            : roles.length === 0
              ? 'This wallet is not one of this trade’s four parties. It could still fund a milestone if one is open for financing.'
              : 'The next move belongs to another party. Switch Freighter to their account and this page will notice.'}
        </Notice>
      ) : (
        <Notice tone="progress" title={`Your next action as ${next.who}`}>
          <p>{next.label}</p>
          <Link className="mt-1 inline-block underline" href={next.href}>
            Open the control
          </Link>
        </Notice>
      )}
    </Card>
  );
}

/**
 * What the connected wallet can do next, taken from the same rules the
 * workspace uses — which mirror the contract's own guards.
 */
function nextStepFor(
  order: OrderWithMilestones,
  milestone: Milestone | null,
  wallet: string | undefined,
  finance: Parameters<typeof milestoneActions>[3],
): { who: string; label: string; href: string } | null {
  if (wallet === undefined) return null;
  const roles = orderRolesFor(wallet, order);
  const who = roles.length > 0 ? roles.map((role) => ROLE_LABELS[role]).join(' and ') : 'funder';

  const orderLevel = orderActions(wallet, order);
  if (orderLevel.includes('accept-order')) {
    return {
      who,
      label: 'Accept this trade so the buyer can protect its milestones.',
      href: nextActionHref(order.orderId, null),
    };
  }
  if (orderLevel.includes('create-milestone') && order.milestones.length === 0) {
    return {
      who,
      label: 'Add the first milestone, then ask the supplier to accept.',
      href: nextActionHref(order.orderId, null),
    };
  }
  if (milestone === null) return null;

  const available = milestoneActions(wallet, order, milestone, finance);
  const first = available[0];
  if (first === undefined) return null;
  const labels: Record<string, string> = {
    'fund-milestone': 'Protect this milestone payment in the contract.',
    'cancel-partial-funding': 'Unwind the partial protection on this milestone.',
    'request-finance': 'Ask funders for working capital against the protected milestone.',
    'cancel-finance-request': 'Withdraw the working-capital request.',
    'accept-offer': 'Choose a funding offer.',
    'release-expired-acceptance': 'Release the expired acceptance so the milestone can move on.',
    'make-offer': 'Offer working capital from your own wallet.',
    'cancel-offer': 'Withdraw your funding offer.',
    'fund-advance': 'Send the advance you offered, from your wallet to the supplier.',
    'submit-evidence': 'Submit the evidence for this milestone.',
    'verify-milestone': 'Check the evidence and verify the milestone.',
    'settle-milestone': 'Settle the milestone: the funder is repaid first, then the supplier.',
    'open-dispute': 'Open a dispute for the resolver to decide.',
    'resolve-dispute': 'Decide this dispute: settle or refund.',
  };
  return {
    who,
    label: labels[first.kind] ?? 'Take the next action on this milestone.',
    href: nextActionHref(order.orderId, milestone.milestoneId),
  };
}

/** Template stages the buyer has not added yet, with the ordinary form. */
function TemplateStages({
  order,
  template,
  wallet,
}: {
  order: OrderWithMilestones;
  template: TradeTemplate;
  wallet: string | undefined;
}) {
  const remaining = template.milestones.slice(order.milestones.length);
  const isBuyer = orderRolesFor(wallet, order).includes('buyer');
  if (remaining.length === 0 || !isBuyer) return null;
  const next = remaining[0];
  if (next === undefined) return null;

  return (
    <Card className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-semibold">Stages from {template.name}</h2>
        <p className="text-sm text-muted">
          {order.milestones.length} of {template.milestones.length} added. Add them all before the
          supplier accepts — after that the contract fixes the milestone set.
        </p>
      </div>
      <ol className="text-sm text-muted">
        {template.milestones.map((stage, index) => (
          <li key={stage.stage}>
            {index < order.milestones.length ? '✓' : '·'} {stage.stage} — {stage.amount} USDC
          </li>
        ))}
      </ol>
      <CreateMilestoneForm
        order={order}
        suggestion={{ stage: next.stage, amount: next.amount, meaning: next.meaning }}
      />
    </Card>
  );
}

/** Real, indexed transactions for this trade. Never a placeholder hash. */
function TradeRecord({ order }: { order: OrderWithMilestones }) {
  return (
    <Card className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">On-chain record</h2>
      <ul className="flex flex-col gap-1 text-sm">
        <li className="flex flex-wrap items-center justify-between gap-2">
          <span>Trade created</span>
          <ExplorerLink hash={order.createdTxHash}>View on Stellar</ExplorerLink>
        </li>
        {order.milestones.map((milestone) => (
          <li
            key={milestone.milestoneId}
            className="flex flex-wrap items-center justify-between gap-2"
          >
            <span>{milestoneTitle(milestone.index)} created</span>
            <ExplorerLink hash={milestone.createdTxHash}>View on Stellar</ExplorerLink>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted">
        Every link is a transaction the indexer read from Stellar. Payments, advances and
        settlements have their own links on the milestone above.
      </p>
    </Card>
  );
}

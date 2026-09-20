'use client';

import { useState } from 'react';

import { describeApiError } from '@/lib/api/client';
import { usePublicMetrics } from '@/lib/api/queries';
import type { MetricDefinition, PublicMetrics } from '@/lib/api/schemas';
import { formatUsdcUnits } from '@/lib/domain/amounts';
import { Badge, Button, Card, ExplorerLink, Loading, Notice } from '../ui/primitives';

/**
 * The public traction surface.
 *
 * Built to be argued with rather than admired. Every figure carries where it
 * came from, protocol activity and outside adoption are never added together,
 * and a zero is printed as a zero — a dashboard that cannot show a zero is a
 * dashboard nobody should believe.
 *
 * There is no input on this page and no number that a browser can influence.
 * It renders what the API computed from indexed chain state.
 */
export function TractionView() {
  const metrics = usePublicMetrics();

  if (metrics.isPending) return <Loading label="Reading indexed chain state…" />;
  if (metrics.isError) {
    return (
      <Notice
        tone="danger"
        title="Could not load the metrics"
        action={
          <Button variant="secondary" className="w-fit" onClick={() => void metrics.refetch()}>
            Try again
          </Button>
        }
      >
        {describeApiError(metrics.error)}
      </Notice>
    );
  }

  const data = metrics.data;
  return (
    <div className="flex flex-col gap-6">
      <Notice tone="attention" title="Stellar Testnet activity">
        {data.scope.note} Indexed through ledger {data.provenance.indexedThroughLedger ?? '—'} from{' '}
        {data.provenance.indexedEvents} contract event
        {data.provenance.indexedEvents === 1 ? '' : 's'}.
      </Notice>

      <NorthStar data={data} />
      <Adoption data={data} />
      <ProtocolActivity data={data} />
      <LocalPayments data={data} />
      <Timings data={data} />
      <Definitions data={data} />
    </div>
  );
}

/** The one number the product is trying to move. */
function NorthStar({ data }: { data: PublicMetrics }) {
  const { northStar } = data;
  const counted = northStar.completedLocalPaymentFinanceCycles;
  return (
    <Card className="flex flex-col gap-4">
      <div>
        <p className="text-xs uppercase tracking-wide text-muted">North-star metric</p>
        <h2 className="text-lg font-semibold">Completed local-payment finance cycles</h2>
      </div>
      <p className="text-5xl font-semibold tabular-nums">{counted}</p>
      <p className="text-sm text-muted">{data.definitions.northStar.definition}</p>

      {northStar.cycles.length === 0 ? (
        <p className="text-sm text-muted">
          No milestone has been financed yet, so no cycle can have completed.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {northStar.cycles.map((cycle) => (
            <li
              key={cycle.milestoneId}
              className="rounded-lg border border-border p-3 text-sm"
              data-testid="cycle-row"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">Milestone #{cycle.milestoneId}</span>
                {cycle.counted ? (
                  <Badge tone="success">Counted</Badge>
                ) : (
                  <Badge tone="neutral">Not counted</Badge>
                )}
                {cycle.link !== null && (
                  <span className="text-xs text-muted">
                    {cycle.link === 'supplier-offramp'
                      ? 'supplier converted the advance to local money'
                      : 'local money entered through the buyer'}
                  </span>
                )}
              </div>
              {cycle.missing.length > 0 && (
                <p className="mt-1 text-xs text-muted">Missing: {cycle.missing.join('; ')}.</p>
              )}
              {cycle.localPaymentTxHash !== null && (
                <p className="mt-1 text-xs">
                  Local-payment leg: <ExplorerLink hash={cycle.localPaymentTxHash} />
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted">
        The link between a conversion and a milestone is the wallet and the order of events, not a
        claim that the same USDC units flowed through — USDC is fungible, and that claim would not
        be true.
      </p>
    </Card>
  );
}

/**
 * Outside adoption, kept rigorously apart from our own activity.
 *
 * A wallet is external only when its owner said so. Nothing is inferred from
 * behaviour, which is why this number can be zero while the protocol numbers
 * below are not.
 */
function Adoption({ data }: { data: PublicMetrics }) {
  const { adoption } = data;
  return (
    <Card className="flex flex-col gap-4">
      <div>
        <p className="text-xs uppercase tracking-wide text-muted">External adoption</p>
        <h2 className="text-lg font-semibold">People outside the team</h2>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Figure label="External wallets" value={adoption.externalWallets} emphasis />
        <Figure label="Team wallets" value={adoption.teamWallets} />
        <Figure label="Unclassified" value={adoption.unclassifiedWallets} />
      </div>
      {adoption.externalWallets === 0 && (
        <Notice tone="attention" title="No external participants yet">
          Every wallet that has touched the contract so far is ours, or has not been classified. We
          would rather show a zero than label our own demo wallets as adoption.
        </Notice>
      )}
      <p className="text-xs text-muted">
        Classification is opt-in: a wallet counts as external only when its owner consented and said
        they are not on the team. Declaring yourself team-side is one-way, so this number can never
        be inflated by re-tagging.
      </p>
    </Card>
  );
}

/** What the contract has actually done, ours included and labelled as such. */
function ProtocolActivity({ data }: { data: PublicMetrics }) {
  const a = data.protocolActivity;
  return (
    <Card className="flex flex-col gap-4">
      <div>
        <p className="text-xs uppercase tracking-wide text-muted">
          Testnet protocol activity · includes our own demo wallets
        </p>
        <h2 className="text-lg font-semibold">What MilvanceCore has done</h2>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Figure label="Orders created" value={a.ordersCreated} />
        <Figure label="Accepted by supplier" value={a.ordersAccepted} />
        <Figure label="Completed" value={a.ordersCompleted} />
        <Figure label="Distinct wallets" value={a.distinctWallets} />
        <Figure label="Milestones created" value={a.milestonesCreated} />
        <Figure label="Milestones protected" value={a.milestonesProtected} />
        <Figure label="USDC protected" value={`${formatUsdcUnits(a.protectedVolume)} USDC`} />
        <Figure label="Financing requests" value={a.financeRequests} />
        <Figure label="Funding offers" value={a.fundingOffers} />
        <Figure label="Advances funded" value={a.advancesFunded} />
        <Figure label="USDC advanced" value={`${formatUsdcUnits(a.advanceVolume)} USDC`} />
        <Figure label="Milestones settled" value={a.milestonesSettled} />
        <Figure
          label="USDC repaid to funders"
          value={`${formatUsdcUnits(a.funderRepaymentVolume)} USDC`}
        />
        <Figure
          label="USDC settled to suppliers"
          value={`${formatUsdcUnits(a.supplierResidualVolume)} USDC`}
        />
        <Figure label="Disputes opened" value={a.disputesOpened} />
        <Figure label="USDC refunded" value={`${formatUsdcUnits(a.refundVolume)} USDC`} />
      </div>
      <p className="text-xs text-muted">
        Buyer escrow and funder advances are separate money and are never added together. Escrow
        already released is still counted as protected — it happened, and forgetting it would make a
        completed trade look like nothing.
      </p>
    </Card>
  );
}

/** Local money: the part no blockchain can vouch for, said plainly. */
function LocalPayments({ data }: { data: PublicMetrics }) {
  const l = data.localPayments;
  return (
    <Card className="flex flex-col gap-4">
      <div>
        <p className="text-xs uppercase tracking-wide text-muted">
          Local payments · reported by the Anchor
        </p>
        <h2 className="text-lg font-semibold">TRY in and out</h2>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Figure label="On-ramps reported" value={l.onRampsReported} />
        <Figure label="Off-ramps reported" value={l.offRampsReported} />
        <Figure label="TRY converted in" value={`${l.tryOnboarded} TRY`} />
        <Figure label="TRY paid to suppliers" value={`${l.tryPaidToSuppliers} TRY`} />
        <Figure label="Legs confirmed on Stellar" value={l.legsChainConfirmed} />
        <Figure label="Legs Stellar contradicts" value={l.legsMismatched} />
        <Figure label="Legs not yet checked" value={l.legsUnchecked} />
      </div>
      {l.legsMismatched > 0 && (
        <Notice tone="attention" title="Some reports do not match Stellar">
          {l.legsMismatched} reported conversion{l.legsMismatched === 1 ? '' : 's'} named a
          transaction that Stellar records differently. They are shown rather than hidden, and they
          support no completed cycle.
        </Notice>
      )}
      <p className="text-xs text-muted">
        A bank transfer leaves no trace on any blockchain, so the TRY figures are the Anchor&rsquo;s
        word. The Stellar side of each report is checked against Horizon: right asset, right
        direction, right wallet, right amount.
      </p>
    </Card>
  );
}

function Timings({ data }: { data: PublicMetrics }) {
  const { timings } = data;
  return (
    <Card className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">How long things take</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <Figure
          label="Median time to complete an order"
          value={duration(timings.medianOrderCompletionSeconds)}
        />
        <Figure
          label="Median time from advance to local cash"
          value={duration(timings.medianTimeToLocalCashSeconds)}
        />
      </div>
      <p className="text-xs text-muted">
        Measured between chain timestamps, not between screens someone visited. A dash means it has
        not happened yet.
      </p>
    </Card>
  );
}

/** Every definition, so a reader can disagree with one. */
function Definitions({ data }: { data: PublicMetrics }) {
  const [open, setOpen] = useState(false);
  const groups: readonly (readonly [string, readonly MetricDefinition[]])[] = [
    ['North-star', [data.definitions.northStar]],
    ['Protocol activity', data.definitions.protocolActivity],
    ['Local payments', data.definitions.localPayments],
    ['Adoption', data.definitions.adoption],
    ['Timings', data.definitions.timings],
  ];

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Where every number comes from</h2>
        <Button variant="secondary" onClick={() => setOpen((current) => !current)}>
          {open ? 'Hide definitions' : `Show all ${data.definitions.count} definitions`}
        </Button>
      </div>
      {!open ? (
        <p className="text-sm text-muted">
          Each metric is defined with its source and its exclusions, and the API serves those
          definitions next to the values.
        </p>
      ) : (
        <div className="flex flex-col gap-5">
          {groups.map(([title, definitions]) => (
            <section key={title} className="flex flex-col gap-3">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">{title}</h3>
              {definitions.map((definition) => (
                <div key={definition.key} className="rounded-lg border border-border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{definition.label}</span>
                    <Badge tone={definition.provenance === 'on-chain' ? 'success' : 'neutral'}>
                      {PROVENANCE_LABELS[definition.provenance]}
                    </Badge>
                    {definition.population === 'external-only' && (
                      <Badge tone="attention">Excludes team</Badge>
                    )}
                  </div>
                  <p className="mt-1 text-sm">{definition.definition}</p>
                  <p className="mt-1 text-xs text-muted">Source: {definition.source}</p>
                  <p className="text-xs text-muted">Excludes: {definition.excludes}</p>
                </div>
              ))}
            </section>
          ))}
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">
              Deliberately not published
            </h3>
            {data.definitions.notDerivable.map((entry) => (
              <p key={entry.key} className="text-xs text-muted">
                <span className="font-mono">{entry.key}</span> — {entry.reason}
              </p>
            ))}
          </section>
        </div>
      )}
    </Card>
  );
}

const PROVENANCE_LABELS: Record<MetricDefinition['provenance'], string> = {
  'on-chain': 'On chain',
  'anchor-reported': 'Anchor-reported',
  'anchor-reported-chain-confirmed': 'Reported, Stellar-checked',
  'self-declared': 'Self-declared',
};

function Figure({
  label,
  value,
  emphasis = false,
}: {
  label: string;
  value: string | number;
  emphasis?: boolean;
}) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className={`tabular-nums ${emphasis ? 'text-3xl font-semibold' : 'text-xl font-medium'}`}>
        {value}
      </p>
    </div>
  );
}

/** Whole units only: a median measured in seconds does not deserve decimals. */
function duration(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.round(seconds / 3600);
  return hours < 48 ? `${hours} h` : `${Math.round(seconds / 86400)} days`;
}

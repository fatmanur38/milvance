'use client';

import Link from 'next/link';

import { describeApiError } from '@/lib/api/client';
import { useMilestoneDisputes, useMilestoneFinance } from '@/lib/api/queries';
import type { Milestone, OrderWithMilestones } from '@/lib/api/schemas';
import { milestoneActions, type MilestoneActionKind } from '@/lib/domain/actions';
import { formatUsdc, formatUsdcUnits } from '@/lib/domain/amounts';
import { moneyView } from '@/lib/domain/money';
import { orderRolesFor, ROLE_LABELS, type Role } from '@/lib/domain/roles';
import {
  DERIVED_STATUS_LABELS,
  MILESTONE_PATH,
  MILESTONE_TONE,
  milestoneStatusLabel,
  milestoneTitle,
} from '@/lib/domain/status';

import {
  EvidenceList,
  SubmitEvidenceAction,
  VerifyMilestoneAction,
} from '../evidence/evidence-panel';
import { MoneyPools } from '../money/money-pools';
import { Address, Badge, Card, DerivedBadge, ExplorerLink, Technical } from '../ui/primitives';
import {
  CancelFinanceRequestAction,
  CancelPartialFundingAction,
  FundAdvanceAction,
  FundMilestoneAction,
  MakeOfferAction,
  OffersTable,
  OpenDisputeAction,
  ReleaseExpiredAcceptanceAction,
  RequestFinanceAction,
  ResolveDisputeAction,
  SettleAction,
} from './milestone-actions';

function Stepper({ status }: { status: Milestone['status'] }) {
  const position = MILESTONE_PATH.indexOf(status);
  return (
    <ol className="flex flex-wrap gap-1 text-[11px]" aria-label="Milestone progress">
      {MILESTONE_PATH.map((step, index) => (
        <li
          key={step}
          className={
            index < position
              ? 'rounded bg-protected-soft px-2 py-0.5 text-protected'
              : index === position
                ? 'rounded bg-accent px-2 py-0.5 font-medium text-accent-foreground'
                : 'rounded bg-border/50 px-2 py-0.5 text-muted'
          }
        >
          {milestoneStatusLabel(step, '0')}
        </li>
      ))}
    </ol>
  );
}

export function MilestoneCard({
  order,
  milestone,
  wallet,
}: {
  order: OrderWithMilestones;
  milestone: Milestone;
  wallet: string | undefined;
}) {
  const finance = useMilestoneFinance(milestone.milestoneId);
  const disputes = useMilestoneDisputes(
    milestone.milestoneId,
    milestone.status === 'DISPUTED' || milestone.status === 'REFUNDED',
  );
  const view = moneyView(milestone, finance.data);
  const actions = milestoneActions(wallet, order, milestone, finance.data);
  const has = (kind: MilestoneActionKind) => actions.some((action) => action.kind === kind);

  const roles: Role[] = [...orderRolesFor(wallet, order)];
  const isFunderHere =
    wallet !== undefined &&
    ((finance.data?.offers ?? []).some((offer) => offer.funder === wallet) ||
      (finance.data?.positions ?? []).some((position) => position.funder === wallet));
  if (isFunderHere) roles.push('funder');

  const acceptedOffer = finance.data?.offers.find((offer) => offer.status === 'ACCEPTED');
  const derived = DERIVED_STATUS_LABELS[milestone.derivedStatus];
  const supplierAdvance =
    roles.includes('supplier') && view.advance !== null && view.advance.status !== 'CLOSED'
      ? view.advance
      : null;
  const showOffers =
    finance.data !== undefined &&
    (finance.data.request !== null || finance.data.offers.length > 0) &&
    ['FINANCE_REQUESTED', 'FINANCED'].includes(milestone.status);

  return (
    <Card as="article" aria-label={milestoneTitle(milestone.index)} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-lg font-semibold" id={`milestone-${milestone.milestoneId}`}>
            {milestoneTitle(milestone.index)}
          </h3>
          <p className="text-xs text-muted">
            Milestone payment {formatUsdc(milestone.amount)}
            {milestone.deadline && ` · target ${new Date(milestone.deadline).toLocaleDateString()}`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={MILESTONE_TONE[milestone.status]}>
            {milestoneStatusLabel(milestone.status, milestone.fundedAmount)}
          </Badge>
          {derived && <DerivedBadge>{derived}</DerivedBadge>}
          {roles.map((role) => (
            <Badge key={role} tone="progress">
              You: {ROLE_LABELS[role]}
            </Badge>
          ))}
        </div>
      </div>

      {milestone.status === 'DISPUTED' || milestone.status === 'REFUNDED' ? null : (
        <Stepper status={milestone.status} />
      )}
      {milestone.derivedStatus === 'DELAYED' && (
        <p className="text-xs text-attention">
          The target date has passed. This is a reminder only — a missed date never releases,
          refunds or moves money on its own.
        </p>
      )}

      {finance.isError && <p className="text-sm text-danger">{describeApiError(finance.error)}</p>}
      <MoneyPools view={view} viewerRoles={roles} viewer={wallet} />

      {supplierAdvance && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-capital/30 p-4">
          <div className="text-sm">
            <p className="font-medium">Turn your advance into local production capital</p>
            <p className="text-muted">Convert USDC to TRY for materials, workers and logistics.</p>
          </div>
          <Link
            className="rounded-lg bg-capital px-3.5 py-2 text-sm font-medium text-white"
            href={`/app/anchor?direction=withdraw&amount=${encodeURIComponent(
              formatUsdcUnits(supplierAdvance.principal).replaceAll(',', ''),
            )}&milestone=${encodeURIComponent(milestone.milestoneId)}`}
          >
            Convert to TRY
          </Link>
        </div>
      )}

      {showOffers && finance.data && (
        <section className="flex flex-col gap-2" aria-label="Working capital">
          <h4 className="text-sm font-semibold">Working capital</h4>
          {finance.data.request && (
            <p className="text-sm text-muted">
              Supplier requested {formatUsdc(finance.data.request.requestedPrincipal)} against{' '}
              {formatUsdc(finance.data.request.protectedAmount)} protected · request{' '}
              {finance.data.request.status.toLowerCase()}
              {finance.data.request.status === 'OPEN' &&
                ` until ${new Date(finance.data.request.expiresAt).toLocaleString()}`}
            </p>
          )}
          <OffersTable
            finance={finance.data}
            wallet={wallet}
            acceptable={
              new Set(
                actions.filter((a) => a.kind === 'accept-offer').map((a) => a.offerId as string),
              )
            }
            withdrawable={
              new Set(
                actions.filter((a) => a.kind === 'cancel-offer').map((a) => a.offerId as string),
              )
            }
          />
        </section>
      )}

      {(milestone.evidenceHash !== null ||
        ['SUBMITTED', 'VERIFIED', 'SETTLED', 'DISPUTED'].includes(milestone.status)) && (
        <section className="flex flex-col gap-2" aria-label="Evidence">
          <h4 className="text-sm font-semibold">Evidence</h4>
          <EvidenceList milestone={milestone} />
        </section>
      )}

      {disputes.data && disputes.data.disputes.length > 0 && (
        <section className="flex flex-col gap-2 text-sm" aria-label="Dispute">
          <h4 className="font-semibold">Dispute</h4>
          {disputes.data.disputes.map((dispute) => (
            <p key={dispute.disputeId} className="text-muted">
              Opened by <Address value={dispute.openedBy} you={dispute.openedBy === wallet} /> on{' '}
              {new Date(dispute.openedAt).toLocaleString()} · resolver{' '}
              <Address value={dispute.resolver} you={dispute.resolver === wallet} /> ·{' '}
              {dispute.status === 'OPEN'
                ? 'awaiting decision'
                : dispute.status === 'RESOLVED_SETTLE'
                  ? 'resolved: settle'
                  : 'resolved: refund'}
            </p>
          ))}
        </section>
      )}

      {actions.length > 0 && (
        <section className="flex flex-col gap-3" aria-label="Your actions">
          <h4 className="text-sm font-semibold">Your next step</h4>
          {has('fund-milestone') && <FundMilestoneAction milestone={milestone} />}
          {has('cancel-partial-funding') && <CancelPartialFundingAction milestone={milestone} />}
          {has('request-finance') && <RequestFinanceAction milestone={milestone} />}
          {has('cancel-finance-request') && <CancelFinanceRequestAction milestone={milestone} />}
          {has('release-expired-acceptance') && (
            <ReleaseExpiredAcceptanceAction milestone={milestone} />
          )}
          {has('make-offer') && finance.data && (
            <MakeOfferAction milestone={milestone} finance={finance.data} />
          )}
          {has('fund-advance') && acceptedOffer && (
            <FundAdvanceAction milestone={milestone} order={order} offer={acceptedOffer} />
          )}
          {has('submit-evidence') && <SubmitEvidenceAction milestone={milestone} />}
          {has('verify-milestone') && <VerifyMilestoneAction milestone={milestone} />}
          {has('settle-milestone') && <SettleAction milestone={milestone} finance={finance.data} />}
          {has('open-dispute') && (
            <OpenDisputeAction
              milestone={milestone}
              role={orderRolesFor(wallet, order).includes('buyer') ? 'buyer' : 'supplier'}
            />
          )}
          {has('resolve-dispute') && (
            <ResolveDisputeAction milestone={milestone} finance={finance.data} />
          )}
        </section>
      )}

      <Technical>
        <span>
          Milestone id {milestone.milestoneId} · contract status {milestone.status}
        </span>
        <span>
          Read model through ledger {milestone.provenance.lastLedger} · created in ledger{' '}
          {milestone.createdLedger}
        </span>
        <ExplorerLink hash={milestone.createdTxHash}>Creation transaction</ExplorerLink>
      </Technical>
    </Card>
  );
}

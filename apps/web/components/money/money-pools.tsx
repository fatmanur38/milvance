import { formatUsdc, formatUsdcUnits } from '@/lib/domain/amounts';
import type { MoneyView } from '@/lib/domain/money';
import type { Role } from '@/lib/domain/roles';

import { Address, ExplorerLink } from '../ui/primitives';

/**
 * The two pools of money on a milestone, shown SIDE BY SIDE and never summed.
 *
 *   Protected by buyer        — held on Stellar; not the supplier's cash.
 *   Working capital received  — the funder's own money, the supplier's to use.
 *
 * The captions are written for the supplier first, because the supplier is the
 * one who could otherwise think "the buyer already paid me".
 */
export function MoneyPools({
  view,
  viewerRoles,
  viewer,
}: {
  view: MoneyView;
  viewerRoles: readonly Role[];
  viewer: string | undefined;
}) {
  const isSupplier = viewerRoles.includes('supplier');
  const advance = view.advance;

  return (
    <div className="grid gap-3 md:grid-cols-2" data-testid="money-pools">
      <div
        className="flex flex-col gap-1 rounded-lg border border-protected/30 bg-protected-soft p-4"
        data-testid="pool-protected"
      >
        <span className="text-xs font-semibold uppercase tracking-wide text-protected">
          {view.escrowReleased ? 'Currently protected' : 'Protected by buyer'}
        </span>
        <span className="text-2xl font-semibold">{formatUsdc(view.protectedHeld)}</span>
        {view.escrowReleased ? (
          <>
            <span className="text-xs text-muted">
              {view.originallyProtected !== null
                ? `Originally protected: ${formatUsdc(view.originallyProtected)}`
                : `Milestone payment: ${formatUsdcUnits(view.protectedTarget)} USDC`}
            </span>
            <span className="mt-1 text-xs text-foreground/80">
              {view.refund
                ? 'The protected payment was returned to the buyer after the dispute was resolved as a refund. The contract no longer holds it.'
                : 'The protected payment was released at settlement. The contract no longer holds it.'}
            </span>
          </>
        ) : (
          <>
            <span className="text-xs text-muted">
              of {formatUsdcUnits(view.protectedTarget)} USDC milestone payment
              {view.fullyProtected ? ' · fully protected' : ''}
            </span>
            <span className="mt-1 text-xs text-foreground/80">
              {isSupplier
                ? 'Held on Stellar until this milestone is verified. This is not money you have received.'
                : 'Held on Stellar by the contract. Released only after verification — never paid early.'}
            </span>
          </>
        )}
      </div>

      <div
        className="flex flex-col gap-1 rounded-lg border border-capital/30 bg-capital-soft p-4"
        data-testid="pool-capital"
      >
        <span className="text-xs font-semibold uppercase tracking-wide text-capital">
          Working capital {advance ? 'received' : ''}
        </span>
        {advance ? (
          <>
            <span className="text-2xl font-semibold">{formatUsdc(advance.principal)}</span>
            <span className="text-xs text-muted">
              Sent by funder <Address value={advance.funder} you={advance.funder === viewer} /> from
              their own capital
              {advance.status === 'REPAID' ? ' · repaid' : ''}
              {advance.status === 'CLOSED' ? ' · closed without repayment' : ''}
            </span>
            <span className="mt-1 text-xs text-foreground/80">
              {isSupplier
                ? 'This is yours to use now — for materials, workers and logistics.'
                : 'Funder money, separate from the buyer’s protected payment.'}
            </span>
            <ExplorerLink hash={advance.fundedTxHash}>Advance transaction</ExplorerLink>
          </>
        ) : view.pendingAdvance ? (
          <>
            <span className="text-2xl font-semibold text-muted">
              {formatUsdc(view.pendingAdvance.principal)}
            </span>
            <span className="text-xs text-muted">
              Offer chosen — waiting for the funder to send it. Nothing has arrived yet.
            </span>
          </>
        ) : (
          <>
            <span className="text-2xl font-semibold text-muted">None</span>
            <span className="text-xs text-muted">
              No funder has advanced working capital on this milestone.
            </span>
          </>
        )}
      </div>

      {view.settlement ? (
        <div
          className="rounded-lg border border-border p-4 text-sm md:col-span-2"
          data-testid="pool-settled"
        >
          <p className="font-medium">Payment complete</p>
          <p className="text-muted">
            {formatUsdc(view.settlement.protectedAmount)} released:{' '}
            {view.settlement.funderRepayment !== '0' && (
              <>{formatUsdc(view.settlement.funderRepayment)} repaid to the funder first, then </>
            )}
            {formatUsdc(view.settlement.supplierPayout)} to the supplier.
          </p>
          <ExplorerLink hash={view.settlement.settledTxHash}>Settlement transaction</ExplorerLink>
        </div>
      ) : view.refund ? (
        <div
          className="rounded-lg border border-border p-4 text-sm md:col-span-2"
          data-testid="pool-refunded"
        >
          <p className="font-medium">Refunded to buyer</p>
          <p className="text-muted">
            {formatUsdc(view.refund.refundedAmount)} of protected money returned to the buyer.
            {view.refund.funderAdvanceOutstanding !== '0' && (
              <>
                {' '}
                The funder’s {formatUsdc(view.refund.funderAdvanceOutstanding)} advance was not
                reversed — the supplier keeps it, and the funder was not repaid from escrow.
              </>
            )}
          </p>
          <ExplorerLink hash={view.refund.refundedTxHash}>Refund transaction</ExplorerLink>
        </div>
      ) : view.awaitingResolver ? (
        <div
          className="rounded-lg border border-attention/30 bg-attention-soft p-4 text-sm md:col-span-2"
          data-testid="pool-dispute"
        >
          <p className="font-medium">Awaiting resolver decision</p>
          <p className="text-muted">
            The resolver decides what happens to the protected {formatUsdc(view.protectedHeld)}.
            Until then it stays locked in the contract and no money moves.
          </p>
          <ul className="mt-2 list-disc pl-5 text-muted">
            <li>
              If they settle:{' '}
              {view.expectedOnVerification &&
              view.expectedOnVerification.funderRepayment !== '0' ? (
                <>
                  the funder is repaid {formatUsdc(view.expectedOnVerification.funderRepayment)}{' '}
                  first, then the supplier receives{' '}
                  {formatUsdc(view.expectedOnVerification.supplierRemainder)}.
                </>
              ) : (
                <>the supplier receives the protected {formatUsdc(view.protectedHeld)}.</>
              )}
            </li>
            <li>
              If they refund: the protected {formatUsdc(view.protectedHeld)} returns to the buyer.
              {advance && advance.status === 'ACTIVE' && (
                <>
                  {' '}
                  The funder’s {formatUsdc(advance.principal)} advance is not clawed back — the
                  supplier keeps it and the funder is not repaid from escrow.
                </>
              )}
            </li>
          </ul>
        </div>
      ) : (
        view.expectedOnVerification && (
          <div
            className="rounded-lg border border-border p-4 text-sm md:col-span-2"
            data-testid="pool-expected"
          >
            <p className="font-medium">
              {view.expectedOnVerification.awaitingSettlement
                ? 'Ready to settle'
                : 'When this milestone is verified'}
            </p>
            <p className="text-muted">
              {view.expectedOnVerification.funderRepayment !== '0' ? (
                <>
                  Funder is repaid {formatUsdc(view.expectedOnVerification.funderRepayment)} first,
                  then the supplier receives{' '}
                  {formatUsdc(view.expectedOnVerification.supplierRemainder)}.
                </>
              ) : (
                <>
                  The supplier receives the full{' '}
                  {formatUsdc(view.expectedOnVerification.supplierRemainder)}.
                </>
              )}{' '}
              {view.expectedOnVerification.awaitingSettlement
                ? 'Soroban executes this split when settlement is triggered; the figures here are a preview.'
                : 'Soroban executes this split; the figures here are a preview.'}
            </p>
          </div>
        )
      )}
    </div>
  );
}

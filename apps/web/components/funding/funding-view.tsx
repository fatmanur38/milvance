'use client';

import Link from 'next/link';

import { describeApiError } from '@/lib/api/client';
import { useFunderOffers, useOpportunities, usePositions } from '@/lib/api/queries';
import type { FunderOffer, Opportunity } from '@/lib/api/schemas';
import { formatUsdc, marginPercent } from '@/lib/domain/amounts';
import { canActAsFunder } from '@/lib/domain/roles';
import { milestoneTitle } from '@/lib/domain/status';
import { isBusy } from '@/lib/tx/lifecycle';
import { useContractTransaction } from '@/lib/tx/use-transaction';

import { FundAdvanceAction, FunderRiskNote } from '../orders/milestone-actions';
import { TransactionStatus } from '../tx/transaction-status';
import { Badge, Button, Card, EmptyState, Loading, Notice } from '../ui/primitives';

const live = (iso: string) => new Date(iso).getTime() > Date.now();

function OpportunityCard({ item, wallet }: { item: Opportunity; wallet: string | undefined }) {
  const open = live(item.expiresAt);
  const independent = canActAsFunder(wallet, item.order);
  return (
    <Card as="article" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium">
          Order #{item.order.orderId} · {milestoneTitle(item.milestone.index)}
        </p>
        <span className="text-xs text-muted">
          {open ? `Open until ${new Date(item.expiresAt).toLocaleString()}` : 'Expired'}
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg bg-protected-soft p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-protected">
            Protected by buyer
          </p>
          <p className="text-lg font-semibold">{formatUsdc(item.protectedAmount)}</p>
          <p className="text-xs text-muted">
            Your repayment comes from this, first, on verification.
          </p>
        </div>
        <div className="rounded-lg bg-capital-soft p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-capital">
            Supplier needs now
          </p>
          <p className="text-lg font-semibold">{formatUsdc(item.requestedPrincipal)}</p>
          <p className="text-xs text-muted">You would send this from your own wallet.</p>
        </div>
      </div>
      {!wallet ? (
        <p className="text-sm text-muted">Connect a wallet to make an offer.</p>
      ) : !independent ? (
        <p className="text-sm text-muted">
          You are a party to this order. Funders must be independent of the buyer, supplier,
          attestor and resolver.
        </p>
      ) : open ? (
        <Link
          href={`/app/orders/${item.order.orderId}#milestone-${item.milestone.milestoneId}`}
          className="w-fit rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-accent-foreground"
        >
          Review and make an offer
        </Link>
      ) : null}
    </Card>
  );
}

function WithdrawOffer({ offer }: { offer: FunderOffer }) {
  const tx = useContractTransaction();
  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="secondary"
        className="w-fit"
        disabled={isBusy(tx.state)}
        onClick={() => void tx.run({ kind: 'cancel-offer', offerId: offer.offerId })}
      >
        Withdraw offer
      </Button>
      <TransactionStatus state={tx.state} onDismiss={tx.reset} />
    </div>
  );
}

function OfferCard({ offer }: { offer: FunderOffer }) {
  const awaitingAdvance =
    offer.status === 'ACCEPTED' &&
    offer.milestone.status === 'FINANCE_REQUESTED' &&
    live(offer.expiresAt);
  return (
    <Card as="article" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">
          Order #{offer.order.orderId} · {milestoneTitle(offer.milestone.index)}
        </p>
        <Badge
          tone={
            offer.status === 'ACCEPTED'
              ? 'attention'
              : offer.status === 'FUNDED'
                ? 'success'
                : 'neutral'
          }
        >
          {offer.status === 'ACCEPTED' ? 'Chosen by supplier' : offer.status.toLowerCase()}
        </Badge>
      </div>
      <p className="text-sm text-muted">
        Advance {formatUsdc(offer.principal)} · repaid {formatUsdc(offer.repayment)} on verification
        ({marginPercent(offer.principal, offer.repayment)}%) · buyer protected{' '}
        {formatUsdc(offer.milestone.fundedAmount)}
      </p>
      {awaitingAdvance && (
        <FundAdvanceAction
          milestone={offer.milestone}
          order={{ ...offer.order, milestones: [offer.milestone] }}
          offer={offer}
        />
      )}
      {offer.status === 'OPEN' && live(offer.expiresAt) && <WithdrawOffer offer={offer} />}
    </Card>
  );
}

export function FundingView({ wallet }: { wallet: string | undefined }) {
  const opportunities = useOpportunities();
  const offers = useFunderOffers(wallet);
  const positions = usePositions(wallet);

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3" aria-label="Opportunities">
        <h2 className="text-lg font-semibold">Finance opportunities</h2>
        <p className="text-sm text-muted">
          Suppliers asking for working capital against milestones a buyer has already protected on
          Stellar. You advance your own capital and are repaid first when the milestone is verified.
        </p>
        <FunderRiskNote />
        {opportunities.isPending ? (
          <Loading />
        ) : opportunities.isError ? (
          <Notice tone="danger">{describeApiError(opportunities.error)}</Notice>
        ) : opportunities.data.opportunities.length === 0 ? (
          <EmptyState title="No open requests right now">
            When a supplier asks for working capital against a protected milestone, it appears here.
          </EmptyState>
        ) : (
          <div className="grid gap-3">
            {opportunities.data.opportunities.map((item) => (
              <OpportunityCard key={item.milestoneId} item={item} wallet={wallet} />
            ))}
          </div>
        )}
      </section>

      {wallet && (
        <section className="flex flex-col gap-3" aria-label="Your offers">
          <h2 className="text-lg font-semibold">Your offers</h2>
          {offers.isPending ? (
            <Loading />
          ) : offers.isError ? (
            <Notice tone="danger">{describeApiError(offers.error)}</Notice>
          ) : offers.data.offers.length === 0 ? (
            <EmptyState title="You have not made any offers" />
          ) : (
            <div className="grid gap-3">
              {offers.data.offers.map((offer) => (
                <OfferCard key={offer.offerId} offer={offer} />
              ))}
            </div>
          )}
        </section>
      )}

      {wallet && (
        <section className="flex flex-col gap-3" aria-label="Your positions">
          <h2 className="text-lg font-semibold">Your positions</h2>
          {positions.isPending ? (
            <Loading />
          ) : positions.isError ? (
            <Notice tone="danger">{describeApiError(positions.error)}</Notice>
          ) : positions.data.positions.length === 0 ? (
            <EmptyState title="No funded positions yet" />
          ) : (
            <div className="grid gap-3">
              {positions.data.positions.map((position) => (
                <Card
                  as="article"
                  key={`${position.milestoneId}-${position.offerId}`}
                  className="flex flex-wrap items-center justify-between gap-2 text-sm"
                >
                  <span>
                    Milestone {position.milestoneId}: advanced {formatUsdc(position.principal)},
                    repayment {formatUsdc(position.repayment)}
                  </span>
                  <Badge
                    tone={
                      position.status === 'REPAID'
                        ? 'success'
                        : position.status === 'ACTIVE'
                          ? 'progress'
                          : 'danger'
                    }
                  >
                    {position.status === 'ACTIVE'
                      ? 'Active — awaiting verification'
                      : position.status === 'REPAID'
                        ? 'Repaid'
                        : 'Closed by refund — not repaid from escrow'}
                  </Badge>
                </Card>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

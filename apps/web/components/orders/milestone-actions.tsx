'use client';

import { useState } from 'react';

import type { Milestone, MilestoneFinance, Offer, OrderWithMilestones } from '@/lib/api/schemas';
import {
  compareUnits,
  formatUsdc,
  formatUsdcUnits,
  marginPercent,
  parseUsdcInput,
  subtractUnits,
} from '@/lib/domain/amounts';
import { shortAddress } from '@/lib/domain/roles';
import { isBusy } from '@/lib/tx/lifecycle';
import { useContractTransaction } from '@/lib/tx/use-transaction';
import { readUsdcHolding } from '@/lib/wallet/balance';

import { TransactionStatus } from '../tx/transaction-status';
import { Button, Field, inputClass, Notice } from '../ui/primitives';
import { ActionPanel } from './action-panel';

const DAY_SECONDS = 86_400n;

/** Expiry as unix seconds from the local clock; choices stay well inside contract windows. */
function expiryIn(days: number): bigint {
  return BigInt(Math.floor(Date.now() / 1000)) + BigInt(days) * DAY_SECONDS;
}

/**
 * Pre-flight for actions that move USDC. Returns a message when the wallet
 * clearly cannot pay; the token contract remains the real check.
 */
async function usdcShortfall(address: string, needed: bigint): Promise<string | null> {
  try {
    const holding = await readUsdcHolding(address);
    if (holding.status === 'unfunded') return 'This Testnet account is not funded yet.';
    if (holding.status === 'no-trustline') {
      return 'This wallet has no USDC trustline. Add the approved USDC in Freighter first.';
    }
    if (holding.units < needed) {
      return `This wallet holds ${formatUsdc(holding.units)}; this needs ${formatUsdc(needed)}.`;
    }
    return null;
  } catch {
    // If Horizon is unreachable, let Stellar's own simulation be the judge.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Buyer
// ---------------------------------------------------------------------------

export function FundMilestoneAction({ milestone }: { milestone: Milestone }) {
  const tx = useContractTransaction();
  const remaining = subtractUnits(milestone.amount, milestone.fundedAmount);
  const [amount, setAmount] = useState(formatUsdcUnits(remaining).replaceAll(',', ''));
  const [error, setError] = useState<string | null>(null);
  const parsed = parseUsdcInput(amount);

  return (
    <ActionPanel
      title="Protect this milestone payment"
      who="You, as buyer"
      tx={tx}
      review={
        parsed.ok && (
          <>
            You will lock {formatUsdc(parsed.units)} into this milestone on Stellar. It is{' '}
            <strong>not</strong> paid to the supplier now — it is released only after the milestone
            is verified, or returned to you if a dispute is resolved as a refund.
          </>
        )
      }
    >
      <Field
        label="Amount to protect (USDC)"
        hint={`${formatUsdc(remaining)} still to protect`}
        error={error ?? (amount === '' || parsed.ok ? null : parsed.error)}
      >
        <input
          className={inputClass}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
        />
      </Field>
      <Button
        className="w-fit"
        disabled={!parsed.ok || isBusy(tx.state)}
        onClick={async () => {
          if (!parsed.ok) return;
          setError(null);
          if (compareUnits(parsed.units, remaining) > 0) {
            setError(`That is more than the ${formatUsdc(remaining)} still to protect.`);
            return;
          }
          const short = await usdcShortfall(tx.walletAddress, parsed.units);
          if (short) {
            setError(short);
            return;
          }
          await tx.run({
            kind: 'fund-milestone',
            milestoneId: milestone.milestoneId,
            amount: parsed.units,
          });
        }}
      >
        Review in wallet
      </Button>
    </ActionPanel>
  );
}

export function CancelPartialFundingAction({ milestone }: { milestone: Milestone }) {
  const tx = useContractTransaction();
  return (
    <ActionPanel
      title="Return partial protection"
      who="You, as buyer"
      tx={tx}
      review={
        <>Your partial deposit of {formatUsdc(milestone.fundedAmount)} returns to your wallet.</>
      }
    >
      <Button
        variant="secondary"
        className="w-fit"
        disabled={isBusy(tx.state)}
        onClick={() =>
          void tx.run({ kind: 'cancel-partial-funding', milestoneId: milestone.milestoneId })
        }
      >
        Review in wallet
      </Button>
    </ActionPanel>
  );
}

// ---------------------------------------------------------------------------
// Supplier
// ---------------------------------------------------------------------------

export function RequestFinanceAction({ milestone }: { milestone: Milestone }) {
  const tx = useContractTransaction();
  const [amount, setAmount] = useState('');
  const [days, setDays] = useState(14);
  const parsed = parseUsdcInput(amount);
  const tooMuch = parsed.ok && compareUnits(parsed.units, milestone.fundedAmount) >= 0;

  return (
    <ActionPanel
      title="Request working capital"
      who="You, as supplier"
      tx={tx}
      review={
        parsed.ok &&
        !tooMuch && (
          <>
            Funders will see a request for {formatUsdc(parsed.units)} of working capital against a
            milestone the buyer has protected with {formatUsdc(milestone.fundedAmount)}. The buyer’s
            money stays locked; a funder advances their own capital.
          </>
        )
      }
    >
      <p className="text-sm text-muted">
        The buyer has protected this milestone, but that money stays locked until it is verified. If
        you need cash now for materials or wages, a funder can advance it — and is repaid first when
        the milestone is verified.
      </p>
      <div className="flex flex-wrap gap-4">
        <Field
          label="Working capital needed (USDC)"
          hint="Must be less than the protected amount, so there is room to repay the funder."
          error={
            amount === ''
              ? null
              : !parsed.ok
                ? parsed.error
                : tooMuch
                  ? 'Ask for less than the protected milestone amount.'
                  : null
          }
        >
          <input
            className={inputClass}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="1400"
          />
        </Field>
        <Field label="Open for">
          <select
            className={inputClass}
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
            <option value={28}>28 days</option>
          </select>
        </Field>
      </div>
      <Button
        className="w-fit"
        disabled={!parsed.ok || tooMuch || isBusy(tx.state)}
        onClick={() =>
          parsed.ok &&
          void tx.run({
            kind: 'request-finance',
            milestoneId: milestone.milestoneId,
            principal: parsed.units,
            expiresAt: expiryIn(days),
          })
        }
      >
        Review in wallet
      </Button>
    </ActionPanel>
  );
}

export function CancelFinanceRequestAction({ milestone }: { milestone: Milestone }) {
  const tx = useContractTransaction();
  return (
    <ActionPanel
      title="Close working-capital request"
      who="You, as supplier"
      tx={tx}
      review={<>The request closes. The buyer’s protection is unaffected; no money moves.</>}
    >
      <Button
        variant="secondary"
        className="w-fit"
        disabled={isBusy(tx.state)}
        onClick={() =>
          void tx.run({ kind: 'cancel-finance-request', milestoneId: milestone.milestoneId })
        }
      >
        Review in wallet
      </Button>
    </ActionPanel>
  );
}

export function ReleaseExpiredAcceptanceAction({ milestone }: { milestone: Milestone }) {
  const tx = useContractTransaction();
  return (
    <ActionPanel
      title="Release the unfunded offer"
      who="You, as supplier"
      tx={tx}
      review={
        <>
          The funder you chose did not send the advance before their offer expired. Releasing it
          lets you seek working capital again. No money moves.
        </>
      }
    >
      <Button
        variant="secondary"
        className="w-fit"
        disabled={isBusy(tx.state)}
        onClick={() =>
          void tx.run({ kind: 'release-expired-acceptance', milestoneId: milestone.milestoneId })
        }
      >
        Review in wallet
      </Button>
    </ActionPanel>
  );
}

/**
 * Competing offers on a request. Everyone can see them — offers are public on
 * Stellar — but only the supplier can choose, and only an offer's funder can
 * withdraw it.
 */
export function OffersTable({
  finance,
  wallet,
  acceptable,
  withdrawable,
}: {
  finance: MilestoneFinance;
  wallet: string | undefined;
  acceptable: ReadonlySet<string>;
  withdrawable: ReadonlySet<string>;
}) {
  const offers = [...finance.offers].sort((a, b) => compareUnits(a.repayment, b.repayment));
  if (offers.length === 0) {
    return <p className="text-sm text-muted">No funding offers yet.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-muted">
          <tr>
            <th className="py-2 pr-4 font-medium">Funder</th>
            <th className="py-2 pr-4 font-medium">Advance now</th>
            <th className="py-2 pr-4 font-medium">Repaid on verification</th>
            <th className="py-2 pr-4 font-medium">Cost</th>
            <th className="py-2 pr-4 font-medium">Status</th>
            <th className="py-2" />
          </tr>
        </thead>
        <tbody>
          {offers.map((offer) => (
            <OfferRow
              key={offer.offerId}
              offer={offer}
              wallet={wallet}
              canAccept={acceptable.has(offer.offerId)}
              canWithdraw={withdrawable.has(offer.offerId)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OfferRow({
  offer,
  wallet,
  canAccept,
  canWithdraw,
}: {
  offer: Offer;
  wallet: string | undefined;
  canAccept: boolean;
  canWithdraw: boolean;
}) {
  const tx = useContractTransaction();
  const expired = new Date(offer.expiresAt).getTime() <= Date.now();
  return (
    <>
      <tr className="border-t border-border">
        <td className="py-2 pr-4">
          <code title={offer.funder} className="font-mono text-xs">
            {shortAddress(offer.funder)}
          </code>
          {offer.funder === wallet && <span className="ml-1 text-xs text-protected">You</span>}
        </td>
        <td className="py-2 pr-4">{formatUsdc(offer.principal)}</td>
        <td className="py-2 pr-4">{formatUsdc(offer.repayment)}</td>
        <td className="py-2 pr-4">{marginPercent(offer.principal, offer.repayment)}%</td>
        <td className="py-2 pr-4 text-xs">
          {offer.status === 'OPEN' && expired ? 'Expired' : offer.status.toLowerCase()}
        </td>
        <td className="py-2 text-right">
          {canAccept && (
            <Button
              disabled={isBusy(tx.state)}
              onClick={() => void tx.run({ kind: 'accept-offer', offerId: offer.offerId })}
            >
              Choose
            </Button>
          )}
          {canWithdraw && (
            <Button
              variant="secondary"
              disabled={isBusy(tx.state)}
              onClick={() => void tx.run({ kind: 'cancel-offer', offerId: offer.offerId })}
            >
              Withdraw
            </Button>
          )}
        </td>
      </tr>
      {tx.state.stage !== 'idle' && (
        <tr>
          <td colSpan={6} className="pb-3">
            <TransactionStatusInline tx={tx} />
          </td>
        </tr>
      )}
    </>
  );
}

function TransactionStatusInline({ tx }: { tx: ReturnType<typeof useContractTransaction> }) {
  return <TransactionStatus state={tx.state} onDismiss={tx.reset} />;
}

// ---------------------------------------------------------------------------
// Funder
// ---------------------------------------------------------------------------

/** Honest risk copy, shown wherever a funder commits capital. */
export function FunderRiskNote() {
  return (
    <Notice tone="attention" title="This is not a guaranteed return">
      You are repaid first from the buyer’s protected payment <em>if</em> the milestone is verified.
      If a dispute is resolved as a refund, the buyer’s money returns to the buyer and your advance
      is <strong>not</strong> repaid from escrow — any claim against the supplier is outside this
      contract. Delays can also postpone repayment.
    </Notice>
  );
}

export function MakeOfferAction({
  milestone,
  finance,
}: {
  milestone: Milestone;
  finance: MilestoneFinance;
}) {
  const tx = useContractTransaction();
  const request = finance.request;
  const [repayment, setRepayment] = useState('');
  const [days, setDays] = useState(3);
  const parsed = parseUsdcInput(repayment);
  if (request === null) return null;

  const principal = request.requestedPrincipal;
  const belowPrincipal = parsed.ok && compareUnits(parsed.units, principal) < 0;
  const aboveProtected = parsed.ok && compareUnits(parsed.units, milestone.fundedAmount) > 0;

  return (
    <ActionPanel
      title="Make a funding offer"
      who="You, as an independent funder"
      tx={tx}
      review={
        parsed.ok &&
        !belowPrincipal &&
        !aboveProtected && (
          <>
            If the supplier chooses you, you will send {formatUsdc(principal)} from your own wallet
            to the supplier, and be repaid {formatUsdc(parsed.units)} first when the milestone is
            verified ({marginPercent(principal, parsed.units)}% over the advance).
          </>
        )
      }
    >
      <div className="grid gap-1 text-sm">
        <span>
          Buyer protected: <strong>{formatUsdc(milestone.fundedAmount)}</strong>
        </span>
        <span>
          Supplier needs now: <strong>{formatUsdc(principal)}</strong>
        </span>
      </div>
      <div className="flex flex-wrap gap-4">
        <Field
          label="Repayment you ask for (USDC)"
          hint="At least the advance, at most the protected amount."
          error={
            repayment === ''
              ? null
              : !parsed.ok
                ? parsed.error
                : belowPrincipal
                  ? 'Repayment cannot be less than the advance.'
                  : aboveProtected
                    ? 'Repayment cannot exceed the protected milestone amount.'
                    : null
          }
        >
          <input
            className={inputClass}
            value={repayment}
            onChange={(e) => setRepayment(e.target.value)}
            inputMode="decimal"
          />
        </Field>
        <Field label="Offer valid for">
          <select
            className={inputClass}
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            <option value={1}>1 day</option>
            <option value={3}>3 days</option>
            <option value={6}>6 days</option>
          </select>
        </Field>
      </div>
      <FunderRiskNote />
      <Button
        className="w-fit"
        disabled={!parsed.ok || belowPrincipal || aboveProtected || isBusy(tx.state)}
        onClick={() =>
          parsed.ok &&
          void tx.run({
            kind: 'make-offer',
            milestoneId: milestone.milestoneId,
            principal: BigInt(principal),
            repayment: parsed.units,
            expiresAt: expiryIn(days),
          })
        }
      >
        Review in wallet
      </Button>
    </ActionPanel>
  );
}

export function FundAdvanceAction({
  milestone,
  order,
  offer,
}: {
  milestone: Milestone;
  order: OrderWithMilestones;
  offer: Offer;
}) {
  const tx = useContractTransaction();
  const [error, setError] = useState<string | null>(null);
  return (
    <ActionPanel
      title="Send the working capital"
      who="You, the chosen funder"
      tx={tx}
      review={
        <>
          {formatUsdc(offer.principal)} moves <strong>from your wallet</strong> to the supplier’s
          wallet ({shortAddress(order.supplier)}). The buyer’s protected{' '}
          {formatUsdc(milestone.fundedAmount)} stays locked and is not touched. You are repaid{' '}
          {formatUsdc(offer.repayment)} first when the milestone is verified.
        </>
      }
    >
      <p className="text-sm text-muted">
        The supplier chose your offer. Send the advance before it expires.
      </p>
      {error && (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      )}
      <FunderRiskNote />
      <Button
        className="w-fit"
        disabled={isBusy(tx.state)}
        onClick={async () => {
          setError(null);
          const short = await usdcShortfall(tx.walletAddress, BigInt(offer.principal));
          if (short) {
            setError(short);
            return;
          }
          const supplier = await readUsdcHolding(order.supplier).catch(() => null);
          if (supplier !== null && supplier.status !== 'ok') {
            setError(
              'The supplier cannot receive USDC yet — their account has no USDC trustline. Ask them to add it first.',
            );
            return;
          }
          await tx.run({ kind: 'fund-advance', milestoneId: milestone.milestoneId });
        }}
      >
        Review in wallet
      </Button>
    </ActionPanel>
  );
}

// ---------------------------------------------------------------------------
// Settlement and disputes
// ---------------------------------------------------------------------------

export function SettleAction({
  milestone,
  finance,
}: {
  milestone: Milestone;
  finance: MilestoneFinance | undefined;
}) {
  const tx = useContractTransaction();
  const position = finance?.positions.find((candidate) => candidate.status === 'ACTIVE');
  return (
    <ActionPanel
      title="Release milestone payment"
      who="Supplier or funder"
      tx={tx}
      review={
        position ? (
          <>
            Stellar pays the funder {formatUsdc(position.repayment)} first, then the supplier{' '}
            {formatUsdc(subtractUnits(milestone.fundedAmount, position.repayment))} — both from the
            buyer’s protected payment, in one transaction.
          </>
        ) : (
          <>Stellar pays the supplier the full protected {formatUsdc(milestone.fundedAmount)}.</>
        )
      }
    >
      <p className="text-sm text-muted">
        This milestone is verified. The protected payment can now be released.
      </p>
      <Button
        className="w-fit"
        disabled={isBusy(tx.state)}
        onClick={() =>
          void tx.run({ kind: 'settle-milestone', milestoneId: milestone.milestoneId })
        }
      >
        Review in wallet
      </Button>
    </ActionPanel>
  );
}

export function OpenDisputeAction({ milestone, role }: { milestone: Milestone; role: string }) {
  const tx = useContractTransaction();
  const [confirmed, setConfirmed] = useState(false);
  return (
    <ActionPanel
      title="Open a dispute"
      who={`You, as ${role}`}
      tx={tx}
      review={
        <>
          Only this milestone is frozen. Other milestones on the order are not affected. The
          resolver assigned to this order decides whether the protected payment is released or
          refunded.
        </>
      }
    >
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        I understand this freezes this milestone until the resolver decides.
      </label>
      <Button
        variant="danger"
        className="w-fit"
        disabled={!confirmed || isBusy(tx.state)}
        onClick={() => void tx.run({ kind: 'open-dispute', milestoneId: milestone.milestoneId })}
      >
        Review in wallet
      </Button>
    </ActionPanel>
  );
}

export function ResolveDisputeAction({
  milestone,
  finance,
}: {
  milestone: Milestone;
  finance: MilestoneFinance | undefined;
}) {
  const tx = useContractTransaction();
  const [choice, setChoice] = useState<'settle' | 'refund' | null>(null);
  const position = finance?.positions.find((candidate) => candidate.status === 'ACTIVE');
  return (
    <ActionPanel
      title="Resolve this dispute"
      who="You, as resolver"
      tx={tx}
      review={
        choice === 'settle' ? (
          <>
            The milestone returns to <strong>verified</strong>. The supplier or funder can then
            release the payment
            {position ? `, with the funder repaid ${formatUsdc(position.repayment)} first` : ''}.
          </>
        ) : choice === 'refund' ? (
          <>
            {formatUsdc(milestone.fundedAmount)} of protected money returns to the{' '}
            <strong>buyer</strong>.
            {position && (
              <>
                {' '}
                The funder’s {formatUsdc(position.principal)} advance is <strong>not</strong>{' '}
                reversed: the supplier keeps it, and the funder is not repaid from escrow.
              </>
            )}
          </>
        ) : undefined
      }
    >
      <fieldset className="flex flex-col gap-2 text-sm">
        <legend className="mb-1 text-muted">The contract allows exactly two outcomes.</legend>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name={`resolve-${milestone.milestoneId}`}
            checked={choice === 'settle'}
            onChange={() => setChoice('settle')}
          />
          Settle — the work stands; release the payment
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name={`resolve-${milestone.milestoneId}`}
            checked={choice === 'refund'}
            onChange={() => setChoice('refund')}
          />
          Refund — return the protected payment to the buyer
        </label>
      </fieldset>
      <Button
        className="w-fit"
        disabled={choice === null || isBusy(tx.state)}
        onClick={() =>
          choice !== null &&
          void tx.run({
            kind: 'resolve-dispute',
            milestoneId: milestone.milestoneId,
            resolution: choice,
          })
        }
      >
        Review in wallet
      </Button>
    </ActionPanel>
  );
}

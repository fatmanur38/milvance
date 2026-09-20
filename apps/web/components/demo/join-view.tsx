'use client';

import Link from 'next/link';

import { ApiError, describeApiError } from '@/lib/api/client';
import { useOrder } from '@/lib/api/queries';
import {
  expectedAddressFor,
  INVITE_ROLE_BRIEF,
  inviteDestination,
  parseInvite,
  type Invite,
  type InviteParams,
} from '@/lib/demo/invite';
import { templateById } from '@/lib/demo/templates';
import { canActAsFunder, orderRolesFor, ROLE_LABELS, shortAddress } from '@/lib/domain/roles';
import { ORDER_STATUS_LABELS } from '@/lib/domain/status';
import { useWallet } from '@/lib/wallet/provider';
import { Address, Button, Card, Loading, Notice } from '../ui/primitives';
import { WalletNotice } from '../wallet/wallet-chip';

/**
 * The page an invite link or a scanned QR code opens.
 *
 * It answers three questions and nothing more: which trade is this, what is the
 * role you were invited as, and is the wallet in your browser the one the
 * contract expects for that role.
 *
 * The `role` in the URL is a HINT. It selects the explanation on this page. It
 * does not grant the role, it is not passed to any contract call, and it cannot
 * make an action appear: the workspace derives what you may do from your
 * connected wallet against the addresses stored on the order, and MilvanceCore
 * checks again when you sign. A stranger opening a resolver link sees a
 * resolver explanation and no resolver powers.
 */
export function JoinView({ params }: { params: InviteParams }) {
  const parsed = parseInvite(params);

  if (!parsed.ok) {
    return (
      <div className="flex flex-col gap-4">
        <Notice tone="danger" title="This invite link is not valid">
          {parsed.reason} Ask whoever shared it for a new link, or open the workspace and find the
          trade yourself.
        </Notice>
        <Link className="text-sm underline" href="/app/orders">
          Go to your orders
        </Link>
      </div>
    );
  }

  return <ValidInvite invite={parsed.invite} />;
}

function ValidInvite({ invite }: { invite: Invite }) {
  const { state } = useWallet();
  const wallet = state.address;
  const order = useOrder(invite.orderId);
  const template = templateById(invite.templateId);

  if (order.isPending) return <Loading label="Loading the trade…" />;
  if (order.isError) {
    const notFound = order.error instanceof ApiError && order.error.kind === 'not-found';
    return (
      <Notice
        tone={notFound ? 'attention' : 'danger'}
        title={
          notFound
            ? `Trade #${invite.orderId} is not in the workspace yet`
            : 'Could not load this trade'
        }
        action={
          <Button variant="secondary" className="w-fit" onClick={() => void order.refetch()}>
            Try again
          </Button>
        }
      >
        {notFound
          ? 'It may not exist, or the indexer may not have caught up with it yet. Nothing about this link grants access either way.'
          : describeApiError(order.error)}
      </Notice>
    );
  }

  const data = order.data;
  const expected = expectedAddressFor(invite.role, data);
  const heldRoles = orderRolesFor(wallet, data);
  const isFunderInvite = invite.role === 'funder';
  const matches = isFunderInvite
    ? canActAsFunder(wallet, data)
    : expected !== null && wallet !== undefined && wallet === expected;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-sm text-muted">Invitation</p>
        <h1 className="text-2xl font-semibold tracking-tight">
          Trade #{data.orderId} · you were invited as {ROLE_LABELS[invite.role]}
        </h1>
        <p className="mt-1 text-sm text-muted">
          Status: {ORDER_STATUS_LABELS[data.status]} · {data.milestones.length} milestone
          {data.milestones.length === 1 ? '' : 's'}
          {template !== null ? ` · ${template.name}` : ''}
        </p>
      </div>

      <Card className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">What this role does</h2>
        <p className="text-sm">{INVITE_ROLE_BRIEF[invite.role]}</p>
        <p className="text-xs text-muted">
          This link only opens the trade and explains the role. It does not give you the role, and
          it cannot sign anything for you.
        </p>
      </Card>

      <Card className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Your wallet</h2>
        <WalletNotice />
        <dl className="grid gap-2 text-sm md:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Expected for this role</dt>
            <dd>
              {expected === null ? (
                <span className="text-muted">
                  Any wallet that is not the buyer, supplier, attestor or resolver
                </span>
              ) : (
                <Address value={expected} />
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Connected now</dt>
            <dd>
              {wallet === undefined ? (
                <span className="text-muted">No wallet connected</span>
              ) : (
                <Address value={wallet} you />
              )}
            </dd>
          </div>
        </dl>

        {wallet === undefined ? (
          <Notice tone="attention" title="Connect your wallet to continue">
            You can read this trade without a wallet — everything on it is public on Stellar. Acting
            on it needs the wallet the contract expects.
          </Notice>
        ) : matches ? (
          <Notice tone="success" title="This wallet matches">
            {isFunderInvite
              ? 'You are independent of this trade’s four parties, so the contract will accept a funding offer from you.'
              : `The contract has this wallet as the ${invite.role} on trade #${data.orderId}.`}
          </Notice>
        ) : (
          <Notice tone="attention" title="This is not the wallet this role expects">
            {isFunderInvite ? (
              <>
                This wallet is the {heldRoles.map((role) => ROLE_LABELS[role]).join(' and ')} on
                this trade. A funder has to be independent of all four parties, so the contract
                would reject an offer from it. Switch to a separate wallet in Freighter — this page
                notices on its own.
              </>
            ) : (
              <>
                The trade names {expected === null ? 'another wallet' : shortAddress(expected)} as
                its {invite.role}. Switch Freighter to that account and this page will notice on its
                own.
                {heldRoles.length > 0 && (
                  <>
                    {' '}
                    The wallet you have connected is the{' '}
                    {heldRoles.map((role) => ROLE_LABELS[role]).join(' and ')} here, so it has those
                    actions instead.
                  </>
                )}
                {heldRoles.length === 0 && (
                  <>
                    {' '}
                    Until then you can read the trade, but the contract will not accept{' '}
                    {invite.role} actions from this wallet.
                  </>
                )}
              </>
            )}
          </Notice>
        )}
      </Card>

      <div className="flex flex-wrap gap-3">
        <Link
          className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background"
          href={inviteDestination(invite)}
        >
          Open the trade
        </Link>
        <Link
          className="rounded-lg border border-border px-4 py-2 text-sm"
          href={`/app/trade-lab/${data.orderId}`}
        >
          Open in Trade Lab
        </Link>
      </div>
    </div>
  );
}

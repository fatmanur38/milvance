'use client';

import Link from 'next/link';
import { useState } from 'react';

import type { OrderWithMilestones } from '@/lib/api/schemas';
import {
  expectedAddressFor,
  INVITE_ROLE_BRIEF,
  invitePath,
  inviteUrl,
  isDeviceLocal,
  shareOrigin,
  type InviteRole,
} from '@/lib/demo/invite';
import { shortAddress } from '@/lib/domain/roles';
import { Address, Button, Card } from '../ui/primitives';
import { QrCode } from './qr-code';

/**
 * Invite links for the people a trade still needs.
 *
 * An invite carries someone to the right trade with the right explanation. It
 * carries no authority: the supplier link works only for the wallet the buyer
 * already wrote into the order on chain, and the page it opens says so. The
 * funder link is different in kind — the contract keeps no funder allowlist, so
 * any independent wallet can act on it.
 */

const SHARE_ROLES: readonly InviteRole[] = ['supplier', 'attestor', 'resolver', 'funder'];

function origin(): string {
  const browser = typeof window === 'undefined' ? '' : window.location.origin;
  return shareOrigin(process.env.NEXT_PUBLIC_TRADE_LAB_ORIGIN, browser);
}

export function InvitePanel({
  order,
  templateId,
  milestoneId,
}: {
  order: OrderWithMilestones;
  templateId: string | null;
  /** Milestone to point a funder at, when one is open for financing. */
  milestoneId: string | null;
}) {
  const [shown, setShown] = useState<InviteRole | null>(null);
  const [copied, setCopied] = useState<InviteRole | null>(null);
  const host = origin();

  return (
    <Card className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">Invite the other side</h2>
        <p className="text-sm text-muted">
          A link opens the trade and explains the role. It grants nothing — the contract decides
          what a wallet may do.
        </p>
      </div>
      <ul className="flex flex-col gap-3">
        {SHARE_ROLES.map((role) => {
          const expected = expectedAddressFor(role, order);
          const target = invitePath({
            orderId: order.orderId,
            role,
            milestoneId: role === 'funder' ? milestoneId : null,
            templateId,
          });
          const absolute =
            host === ''
              ? null
              : inviteUrl(host, {
                  orderId: order.orderId,
                  role,
                  milestoneId: role === 'funder' ? milestoneId : null,
                  templateId,
                });

          return (
            <li key={role} className="rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium capitalize">{role}</p>
                  <p className="text-xs text-muted">{INVITE_ROLE_BRIEF[role]}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      if (absolute === null) return;
                      void navigator.clipboard?.writeText(absolute).then(
                        () => setCopied(role),
                        () => setCopied(null),
                      );
                    }}
                  >
                    {copied === role ? 'Copied' : 'Copy link'}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => setShown((current) => (current === role ? null : role))}
                  >
                    {shown === role ? 'Hide QR' : 'Show QR'}
                  </Button>
                  <Link className="text-sm underline" href={target}>
                    Open
                  </Link>
                </div>
              </div>
              <p className="mt-2 text-xs text-muted">
                {expected === null ? (
                  <>
                    Any wallet that is not the buyer, supplier, attestor or resolver of this trade
                    can fund it. The contract enforces that independence.
                  </>
                ) : (
                  <>
                    Only <Address value={expected} /> can act as {role} here — that address is on
                    the order on Stellar.
                  </>
                )}
              </p>
              {shown === role && absolute !== null && (
                <div className="mt-3 flex flex-wrap items-center gap-4">
                  <QrCode payload={absolute} label={`Invite QR for the ${role}`} />
                  <p className="max-w-xs break-all font-mono text-xs text-muted">{absolute}</p>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {host !== '' && isDeviceLocal(host) && (
        <p className="text-xs text-muted">
          These links point at {host}, which only resolves on this computer — a phone scanning the
          QR would look for the app on itself. Serve the app on an address the other device can
          reach, or set NEXT_PUBLIC_TRADE_LAB_ORIGIN to that address, and the links follow.
        </p>
      )}
      <p className="text-xs text-muted">
        Sharing a link with the wrong person changes nothing: they would see the trade and be told
        which wallet it expects. Trade {order.orderId} belongs to buyer {shortAddress(order.buyer)}.
      </p>
    </Card>
  );
}

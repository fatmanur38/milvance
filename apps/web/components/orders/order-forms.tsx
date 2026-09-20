'use client';

import { StrKey } from '@stellar/stellar-sdk';
import { useState } from 'react';

import type { OrderWithMilestones } from '@/lib/api/schemas';
import { formatUsdc, parseUsdcInput } from '@/lib/domain/amounts';
import { isBusy } from '@/lib/tx/lifecycle';
import { useContractTransaction } from '@/lib/tx/use-transaction';

import { Button, Field, inputClass } from '../ui/primitives';
import { ActionPanel } from './action-panel';

/** Mirrors the contract's party rules so mistakes surface before the wallet prompt. */
export function partyProblem(
  buyer: string,
  parties: { supplier: string; attestor: string; resolver: string },
): string | null {
  const all = [buyer, parties.supplier, parties.attestor, parties.resolver];
  if (all.some((address) => !StrKey.isValidEd25519PublicKey(address))) {
    return 'Each party needs a valid Stellar public address (G…).';
  }
  if (new Set(all).size !== all.length) {
    return 'Buyer, supplier, attestor and resolver must be four different accounts.';
  }
  return null;
}

export function CreateOrderForm() {
  const tx = useContractTransaction();
  const [supplier, setSupplier] = useState('');
  const [attestor, setAttestor] = useState('');
  const [resolver, setResolver] = useState('');
  const parties = {
    supplier: supplier.trim(),
    attestor: attestor.trim(),
    resolver: resolver.trim(),
  };
  const filled = parties.supplier && parties.attestor && parties.resolver;
  const problem = filled ? partyProblem(tx.walletAddress, parties) : null;

  return (
    <ActionPanel
      title="Create an order"
      who="You, as buyer"
      tx={tx}
      review={
        filled &&
        !problem && (
          <>
            Creates an order with you as buyer. No money moves. You then add milestones, the
            supplier accepts, and you protect each milestone payment when it is due.
          </>
        )
      }
    >
      <p className="text-sm text-muted">
        The attestor verifies milestone evidence; the resolver decides disputes. Both must be
        independent of you and the supplier.
      </p>
      <div className="grid gap-3 md:grid-cols-3">
        {(
          [
            ['Supplier address', supplier, setSupplier],
            ['Attestor address', attestor, setAttestor],
            ['Resolver address', resolver, setResolver],
          ] as const
        ).map(([label, value, set]) => (
          <Field key={label} label={label}>
            <input
              className={`${inputClass} font-mono text-xs`}
              value={value}
              onChange={(e) => set(e.target.value)}
              placeholder="G…"
            />
          </Field>
        ))}
      </div>
      {problem && (
        <p className="text-sm text-danger" role="alert">
          {problem}
        </p>
      )}
      <Button
        className="w-fit"
        disabled={!filled || problem !== null || isBusy(tx.state)}
        onClick={() => void tx.run({ kind: 'create-order', ...parties })}
      >
        Review in wallet
      </Button>
    </ActionPanel>
  );
}

export function CreateMilestoneForm({ order }: { order: OrderWithMilestones }) {
  const tx = useContractTransaction();
  const [amount, setAmount] = useState('');
  const [target, setTarget] = useState('');
  const parsed = parseUsdcInput(amount);
  const deadline =
    target === '' ? null : BigInt(Math.floor(new Date(`${target}T23:59:59`).getTime() / 1000));
  const pastDeadline = deadline !== null && deadline * 1000n <= BigInt(Date.now());

  return (
    <ActionPanel
      title="Add a milestone"
      who="You, as buyer"
      tx={tx}
      review={
        parsed.ok && (
          <>
            Adds milestone {order.milestones.length + 1} with a payment of{' '}
            {formatUsdc(parsed.units)}. No money moves yet — you protect it later, when the supplier
            has accepted.
            {deadline !== null &&
              ' The target date is a planning reminder only; missing it never moves money.'}
          </>
        )
      }
    >
      <p className="text-sm text-muted">
        Common stages: raw materials, production and QC, handover to the carrier, delivery. Stellar
        treats every milestone the same way; the stage is for the people involved.
      </p>
      <div className="flex flex-wrap gap-4">
        <Field
          label="Milestone payment (USDC)"
          error={amount === '' || parsed.ok ? null : parsed.error}
        >
          <input
            className={inputClass}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="2000"
          />
        </Field>
        <Field
          label="Target date (optional)"
          error={pastDeadline ? 'Choose a date in the future.' : null}
        >
          <input
            type="date"
            className={inputClass}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
        </Field>
      </div>
      <Button
        className="w-fit"
        disabled={!parsed.ok || pastDeadline || isBusy(tx.state)}
        onClick={() =>
          parsed.ok &&
          void tx.run({
            kind: 'create-milestone',
            orderId: order.orderId,
            amount: parsed.units,
            deadline,
          })
        }
      >
        Review in wallet
      </Button>
    </ActionPanel>
  );
}

export function AcceptOrderAction({ order }: { order: OrderWithMilestones }) {
  const tx = useContractTransaction();
  return (
    <ActionPanel
      title="Accept this order"
      who="You, as supplier"
      tx={tx}
      review={
        <>
          You agree to deliver {order.milestones.length} milestone
          {order.milestones.length === 1 ? '' : 's'}. After this the milestone set is fixed. The
          buyer then protects each payment before it is due — you can see it locked on Stellar.
        </>
      }
    >
      <Button
        className="w-fit"
        disabled={isBusy(tx.state)}
        onClick={() => void tx.run({ kind: 'accept-order', orderId: order.orderId })}
      >
        Review in wallet
      </Button>
    </ActionPanel>
  );
}

export function CancelOrderAction({ order }: { order: OrderWithMilestones }) {
  const tx = useContractTransaction();
  return (
    <ActionPanel
      title="Cancel this order"
      who="You, as buyer"
      tx={tx}
      review={<>The draft order is cancelled. No money has moved.</>}
    >
      <Button
        variant="danger"
        className="w-fit"
        disabled={isBusy(tx.state)}
        onClick={() => void tx.run({ kind: 'cancel-order', orderId: order.orderId })}
      >
        Review in wallet
      </Button>
    </ActionPanel>
  );
}

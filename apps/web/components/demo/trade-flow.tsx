'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { buildFlow, flowScale, type FlowFrame, type Party, type Pool } from '@/lib/demo/flow';
import type { TourStep } from '@/lib/demo/tour';
import { formatUsdcUnits } from '@/lib/domain/amounts';

/**
 * The trade, animated.
 *
 * The one thing a reader has to believe about Milvance is that buyer escrow
 * and a funder's advance are separate money. A paragraph asks them to take
 * that on trust. Here they watch it: the funder's coin travels its own curve
 * straight to the supplier, passing underneath an escrow box that does not
 * move, in a different colour, at the same time as the escrow meter stays
 * exactly where it was.
 *
 * Every amount and every movement comes from an indexed contract event. The
 * animation is a way of reading the ledger, not a story told over it.
 */

const NODES: Record<Party, { x: number; y: number; label: string; sub: string }> = {
  buyer: { x: 96, y: 96, label: 'Buyer', sub: 'protects the payment' },
  escrow: { x: 400, y: 96, label: 'MilvanceCore', sub: 'holds it on Stellar' },
  supplier: { x: 704, y: 96, label: 'Supplier', sub: 'does the work' },
  funder: { x: 96, y: 300, label: 'Funder', sub: 'own capital' },
};

/**
 * The path each transfer travels.
 *
 * The funder→supplier curve deliberately sweeps BELOW the escrow box. If it
 * passed through, the picture would say the opposite of what the contract
 * does, and a reader would be right to conclude the buyer is prepaying.
 */
function pathFor(from: Party, to: Party): string {
  const a = NODES[from];
  const b = NODES[to];
  if (from === 'funder' && to === 'supplier') return `M ${a.x} ${a.y} Q 400 400 ${b.x} ${b.y}`;
  if (from === 'escrow' && to === 'funder') return `M ${a.x} ${a.y} Q 240 260 ${b.x} ${b.y}`;
  return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
}

/**
 * The two semantic colours the design system already reserves for exactly this
 * distinction. Reusing them is the point: escrow is the same blue here as on
 * every milestone card, and the advance is the same green.
 */
const POOL_COLOUR: Record<Pool, string> = {
  protected: 'var(--protected)',
  advance: 'var(--capital)',
};

export function TradeFlow({
  steps,
  index,
  onIndexChange,
}: {
  steps: readonly TourStep[];
  index: number;
  onIndexChange: (next: number) => void;
}) {
  const frames = useMemo(() => buildFlow(steps), [steps]);
  const scale = useMemo(() => flowScale(frames), [frames]);
  const [playing, setPlaying] = useState(true);
  const reduced = usePrefersReducedMotion();
  const frame = frames[index];

  // Autoplay walks the story; any interaction hands control back to the reader.
  useEffect(() => {
    if (!playing || reduced) return;
    if (index >= frames.length - 1) {
      setPlaying(false);
      return;
    }
    const moving = (frame?.transfers.length ?? 0) > 0;
    const timer = setTimeout(() => onIndexChange(index + 1), moving ? 2600 : 1400);
    return () => clearTimeout(timer);
  }, [playing, reduced, index, frames.length, frame, onIndexChange]);

  if (frame === undefined) return null;

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-xl border border-border bg-foreground/[0.02]">
        <svg
          viewBox="0 0 800 400"
          className="h-auto w-full"
          role="img"
          aria-label={describe(frame, steps[index])}
        >
          <defs>
            <marker
              id="flow-arrow"
              markerWidth="8"
              markerHeight="8"
              refX="6"
              refY="4"
              orient="auto"
            >
              <path d="M0 0 L8 4 L0 8 z" fill="currentColor" opacity="0.35" />
            </marker>
            {/*
              Keeps a node's meter inside its circle. `userSpaceOnUse` means the
              circle is placed in whatever coordinate system references it, which
              for a rect inside a translated group is that group's own origin.
            */}
            <clipPath id="flow-node-clip" clipPathUnits="userSpaceOnUse">
              <circle cx={0} cy={0} r={34} />
            </clipPath>
          </defs>

          {/* Routes, always visible so the two paths read as structural. */}
          {(
            [
              ['buyer', 'escrow'],
              ['escrow', 'supplier'],
              ['funder', 'supplier'],
            ] as const
          ).map(([from, to]) => (
            <path
              key={`${from}-${to}`}
              d={pathFor(from, to)}
              fill="none"
              stroke="currentColor"
              strokeOpacity={0.14}
              strokeWidth={2}
              strokeDasharray={from === 'funder' ? '6 6' : undefined}
              markerEnd="url(#flow-arrow)"
            />
          ))}

          <text x="248" y="80" textAnchor="middle" className="fill-current text-[11px] opacity-40">
            protected
          </text>
          <text x="400" y="368" textAnchor="middle" className="fill-current text-[11px] opacity-40">
            advance — never through escrow
          </text>

          {(Object.keys(NODES) as Party[]).map((party) => (
            <Node
              key={party}
              party={party}
              active={frame.active.includes(party)}
              balance={balanceOf(frame, party)}
              scale={scale}
            />
          ))}

          {/* One coin per transfer. Keyed by frame so SMIL replays on change. */}
          {frame.transfers.map((transfer, position) => (
            <Coin
              key={`${frame.stepId}-${position}`}
              path={pathFor(transfer.from, transfer.to)}
              colour={POOL_COLOUR[transfer.pool]}
              amount={transfer.amount}
              label={transfer.label}
              delay={position * 0.25}
              still={reduced}
            />
          ))}
        </svg>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="rounded-lg border border-border px-3 py-1.5 text-sm"
          onClick={() => {
            if (index >= frames.length - 1) onIndexChange(0);
            setPlaying((current) => !current || index >= frames.length - 1);
          }}
        >
          {playing && index < frames.length - 1
            ? 'Pause'
            : index >= frames.length - 1
              ? 'Replay'
              : 'Play'}
        </button>

        <ol className="flex flex-1 flex-wrap items-center gap-1" aria-label="Trade timeline">
          {frames.map((candidate, position) => (
            <li key={candidate.stepId}>
              <button
                type="button"
                aria-current={position === index}
                aria-label={`Step ${position + 1}: ${steps[position]?.title ?? ''}`}
                title={steps[position]?.title}
                onClick={() => {
                  setPlaying(false);
                  onIndexChange(position);
                }}
                className={`h-2.5 rounded-full transition-all ${
                  position === index
                    ? 'w-8 bg-foreground'
                    : candidate.transfers.length > 0
                      ? 'w-2.5 bg-foreground/40 hover:bg-foreground/70'
                      : 'w-2.5 bg-foreground/15 hover:bg-foreground/40'
                }`}
              />
            </li>
          ))}
        </ol>

        <span className="text-xs tabular-nums text-muted">
          {index + 1} / {frames.length}
        </span>
      </div>

      <div className="flex flex-wrap gap-4 text-xs text-muted">
        <Key colour="var(--protected)" label="Buyer’s protected payment" />
        <Key colour="var(--capital)" label="Funder’s own capital" />
      </div>
    </div>
  );
}

function Key({ colour, label }: { colour: string; label: string }) {
  return (
    <span className="flex items-center gap-2">
      <span className="h-2.5 w-2.5 rounded-full" style={{ background: colour }} />
      {label}
    </span>
  );
}

/** A party, with a meter showing what it is holding right now. */
function Node({
  party,
  active,
  balance,
  scale,
}: {
  party: Party;
  active: boolean;
  balance: { amount: string; pool: Pool } | null;
  scale: bigint;
}) {
  const node = NODES[party];
  const filled = balance === null ? 0 : Number((BigInt(balance.amount) * 100n) / scale) / 100;
  const height = Math.max(0, Math.min(1, filled)) * 44;

  return (
    <g transform={`translate(${node.x} ${node.y})`} data-testid={`flow-node-${party}`}>
      <circle
        r={34}
        className="fill-background"
        stroke="currentColor"
        strokeOpacity={active ? 0.9 : 0.25}
        strokeWidth={active ? 2.5 : 1.5}
        style={{ transition: 'stroke-opacity 400ms, stroke-width 400ms' }}
      />
      {/* The meter fills from the bottom: money you can see accumulating. */}
      {balance !== null && (
        <rect
          x={-34}
          y={22 - height}
          width={68}
          height={height}
          fill={POOL_COLOUR[balance.pool]}
          opacity={0.22}
          style={{ transition: 'height 700ms ease-out, y 700ms ease-out' }}
          clipPath="url(#flow-node-clip)"
        />
      )}
      <text textAnchor="middle" y={-44} className="fill-current text-[13px] font-medium">
        {node.label}
      </text>
      <text textAnchor="middle" y={-30} className="fill-current text-[10px] opacity-50">
        {node.sub}
      </text>
      {balance !== null && (
        <text
          textAnchor="middle"
          y={5}
          className="fill-current text-[13px] font-semibold tabular-nums"
        >
          {formatUsdcUnits(balance.amount)}
        </text>
      )}
      {balance !== null && (
        <text textAnchor="middle" y={19} className="fill-current text-[9px] opacity-50">
          USDC
        </text>
      )}
    </g>
  );
}

/**
 * An amount travelling a path.
 *
 * `animateMotion` rather than a JS loop: the browser owns the timing, it costs
 * nothing when the tab is hidden, and remounting on a key change replays it.
 */
function Coin({
  path,
  colour,
  amount,
  label,
  delay,
  still,
}: {
  path: string;
  colour: string;
  amount: string;
  label: string;
  delay: number;
  still: boolean;
}) {
  return (
    <g data-testid="flow-coin" data-amount={amount}>
      <g>
        {!still && (
          <animateMotion dur="1.9s" begin={`${delay}s`} fill="freeze" path={path} rotate="0" />
        )}
        <circle r={21} fill={colour} opacity={0.95} />
        <text
          textAnchor="middle"
          y={4}
          className="text-[11px] font-semibold tabular-nums"
          fill="#ffffff"
        >
          {formatUsdcUnits(amount)}
        </text>
        <text textAnchor="middle" y={36} className="fill-current text-[10px]" opacity={0.7}>
          {label}
        </text>
      </g>
    </g>
  );
}

/** What each party is holding, so a meter never mixes the two pools. */
function balanceOf(frame: FlowFrame, party: Party): { amount: string; pool: Pool } | null {
  switch (party) {
    case 'escrow':
      return { amount: frame.balances.escrow, pool: 'protected' };
    case 'supplier':
      return { amount: frame.balances.supplier, pool: 'advance' };
    case 'funder':
      return { amount: frame.balances.funderExposed, pool: 'advance' };
    case 'buyer':
      return frame.balances.buyerRefunded === '0'
        ? null
        : { amount: frame.balances.buyerRefunded, pool: 'protected' };
    default:
      return null;
  }
}

function describe(frame: FlowFrame, step: TourStep | undefined): string {
  if (frame.transfers.length === 0) return step?.title ?? 'Trade step';
  return frame.transfers
    .map(
      (transfer) =>
        `${formatUsdcUnits(transfer.amount)} USDC from ${transfer.from} to ${transfer.to}, ${transfer.label}`,
    )
    .join('; ');
}

/** Respect a reader who has asked the system for less movement. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  const query = useRef<MediaQueryList | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    query.current = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.current.matches);
    const listener = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.current.addEventListener('change', listener);
    return () => query.current?.removeEventListener('change', listener);
  }, []);

  return reduced;
}

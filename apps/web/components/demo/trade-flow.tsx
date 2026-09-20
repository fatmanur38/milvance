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
  buyer: { x: 105, y: 128, label: 'Buyer', sub: 'protects the payment' },
  escrow: { x: 400, y: 128, label: 'MilvanceCore', sub: 'buyer money locked' },
  supplier: { x: 695, y: 128, label: 'Supplier', sub: 'receives the advance' },
  funder: { x: 105, y: 305, label: 'Funder', sub: 'uses separate capital' },
};

const ROLE_EXPLANATION: Record<Party, string> = {
  buyer: 'The buyer commits the milestone payment. It stays protected until an authorized outcome.',
  escrow: 'The contract holds buyer money. It never sends the early working-capital advance.',
  supplier:
    'This total is USDC actually received across the trade, including an advance and any settlement remainder.',
  funder:
    'The funder sends its own capital to the supplier and waits for repayment from verified escrow.',
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
  protected: '#80aaff',
  advance: '#5ee5b3',
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
  const [focusedParty, setFocusedParty] = useState<Party | null>(null);
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
    const timer = setTimeout(() => onIndexChange(index + 1), moving ? 3900 : 2500);
    return () => clearTimeout(timer);
  }, [playing, reduced, index, frames.length, frame, onIndexChange]);

  if (frame === undefined) return null;

  const goTo = (next: number) => {
    setPlaying(false);
    onIndexChange(Math.max(0, Math.min(frames.length - 1, next)));
  };

  return (
    <section aria-label="Interactive Testnet trade replay" className="flex min-w-0 flex-col gap-4">
      <div
        className="min-w-0 overflow-hidden rounded-3xl border border-slate-700 shadow-2xl"
        style={{
          background: 'radial-gradient(circle at 48% 38%, #243858 0%, #111d32 48%, #0b1323 100%)',
          color: '#e2e8f0',
        }}
      >
        <div className="flex items-center justify-between gap-3 px-5 pt-4 text-xs">
          <span className="min-w-0 font-semibold uppercase tracking-[0.18em] text-sky-200">
            <span className="sm:hidden">Testnet replay</span>
            <span className="hidden sm:inline">Real Testnet event replay</span>
          </span>
          <span className="shrink-0 whitespace-nowrap rounded-full border border-slate-600 px-3 py-1 tabular-nums text-slate-300">
            {index + 1} / {frames.length}
          </span>
        </div>
        <svg
          viewBox="0 0 800 400"
          className="hidden h-auto w-full md:block"
          role="group"
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
              <path d="M0 0 L8 4 L0 8 z" fill="#74849a" opacity="0.8" />
            </marker>
          </defs>

          {/* Routes, always visible so the two paths read as structural. */}
          {(
            [
              ['buyer', 'escrow'],
              ['escrow', 'supplier'],
              ['funder', 'supplier'],
              ['escrow', 'funder'],
              ['escrow', 'buyer'],
            ] as const
          ).map(([from, to]) => (
            <path
              key={`${from}-${to}`}
              d={pathFor(from, to)}
              fill="none"
              stroke="#8291a5"
              strokeOpacity={0.35}
              strokeWidth={2}
              strokeDasharray={from === 'funder' ? '6 6' : undefined}
              markerEnd="url(#flow-arrow)"
            />
          ))}

          {frame.transfers.map((transfer, position) => (
            <path
              key={frame.stepId + '-route-' + position}
              d={pathFor(transfer.from, transfer.to)}
              fill="none"
              stroke={POOL_COLOUR[transfer.pool]}
              strokeWidth={4}
              strokeDasharray="10 10"
              strokeOpacity={0.9}
            >
              {!reduced && (
                <animate
                  attributeName="stroke-dashoffset"
                  from="20"
                  to="0"
                  dur="0.8s"
                  repeatCount="indefinite"
                />
              )}
            </path>
          ))}

          <text x="250" y="66" textAnchor="middle" fill="#9bbcff" fontSize="12">
            BUYER PROTECTION
          </text>
          <text x="410" y="376" textAnchor="middle" fill="#72e7b5" fontSize="12">
            FUNDER ADVANCE · NEVER THROUGH ESCROW
          </text>

          {(Object.keys(NODES) as Party[]).map((party) => (
            <Node
              key={party}
              party={party}
              active={frame.active.includes(party)}
              balance={balanceOf(frame, party)}
              scale={scale}
              selected={focusedParty === party}
              onSelect={() => setFocusedParty((current) => (current === party ? null : party))}
            />
          ))}

          {/* One coin per transfer. Keyed by frame so SMIL replays on change. */}
          {frame.transfers.map((transfer, position) => (
            <Coin
              key={`${frame.stepId}-${position}`}
              path={pathFor(transfer.from, transfer.to)}
              colour={POOL_COLOUR[transfer.pool]}
              amount={transfer.amount}
              delay={position * 0.25}
              still={reduced}
            />
          ))}
        </svg>
        <div className="grid grid-cols-2 gap-3 p-4 md:hidden">
          {(Object.keys(NODES) as Party[]).map((party) => {
            const balance = balanceOf(frame, party);
            const colour =
              party === 'buyer' || party === 'escrow' ? POOL_COLOUR.protected : POOL_COLOUR.advance;
            return (
              <button
                key={party}
                type="button"
                aria-pressed={focusedParty === party}
                onClick={() => setFocusedParty((current) => (current === party ? null : party))}
                className="min-h-28 min-w-0 rounded-xl border bg-slate-900 p-2 text-left min-[360px]:p-3"
                style={{ borderColor: frame.active.includes(party) ? colour : '#475569' }}
              >
                <span className="block break-words text-xs font-semibold min-[360px]:text-sm">
                  {party === 'escrow' ? 'Milvance' : NODES[party].label}
                </span>
                <span className="block text-[11px] text-slate-400">{NODES[party].sub}</span>
                <strong className="mt-3 block break-words text-sm tabular-nums min-[360px]:text-base">
                  {balance ? formatUsdcUnits(balance.amount) + ' USDC' : 'Funds the milestone'}
                </strong>
              </button>
            );
          })}
        </div>
        {frame.transfers.length > 0 && (
          <div className="space-y-1 px-4 pb-4 md:hidden" aria-hidden="true">
            {frame.transfers.map((transfer, position) => (
              <svg
                key={`${frame.stepId}-mobile-route-${position}`}
                viewBox="0 0 300 18"
                className="h-5 w-full"
              >
                <path
                  d="M 10 9 H 290"
                  stroke={POOL_COLOUR[transfer.pool]}
                  strokeOpacity={0.45}
                  strokeWidth={2}
                />
                <circle cx={reduced ? 290 : 10} cy={9} r={6} fill={POOL_COLOUR[transfer.pool]}>
                  {!reduced && (
                    <animate attributeName="cx" from="10" to="290" dur="2.3s" fill="freeze" />
                  )}
                </circle>
              </svg>
            ))}
          </div>
        )}
        <div className="flex min-h-12 flex-wrap items-center gap-x-5 gap-y-1 border-t border-slate-700 bg-slate-950/50 px-5 py-3 text-xs text-slate-200">
          {frame.transfers.length === 0 ? (
            <span>
              No money moves in this event. The contract records a decision or commitment.
            </span>
          ) : (
            frame.transfers.map((transfer, position) => (
              <span
                key={frame.stepId + '-transfer-' + position}
                className="inline-flex min-w-0 flex-wrap items-center gap-2"
              >
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ background: POOL_COLOUR[transfer.pool] }}
                />
                <strong className="break-all tabular-nums">
                  {formatUsdcUnits(transfer.amount)} USDC
                </strong>
                <span className="text-slate-400">
                  {NODES[transfer.from].label} → {NODES[transfer.to].label}
                </span>
              </span>
            ))
          )}
        </div>
      </div>

      <div className="flex min-h-6 flex-wrap items-center justify-between gap-3 text-xs text-muted">
        <span>
          {focusedParty
            ? ROLE_EXPLANATION[focusedParty]
            : 'Select a role in the map to see what its money means.'}
        </span>
        <span className="flex flex-wrap gap-4">
          <Key colour={POOL_COLOUR.protected} label="Buyer’s protected payment" />
          <Key colour={POOL_COLOUR.advance} label="Funder’s own capital" />
        </span>
      </div>

      <div className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-40"
            onClick={() => goTo(index - 1)}
            disabled={index === 0}
          >
            ← Previous
          </button>
          <button
            type="button"
            className="rounded-lg bg-foreground px-4 py-2 text-sm font-semibold text-background"
            onClick={() => {
              if (index >= frames.length - 1) onIndexChange(0);
              setPlaying((current) => !current || index >= frames.length - 1);
            }}
          >
            {playing && index < frames.length - 1
              ? 'Ⅱ Pause'
              : index >= frames.length - 1
                ? '↻ Replay'
                : '▶ Play'}
          </button>
          <button
            type="button"
            className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-40"
            onClick={() => goTo(index + 1)}
            disabled={index >= frames.length - 1}
          >
            Next →
          </button>
          <span className="ml-auto text-xs font-medium text-muted">{steps[index]?.title}</span>
        </div>
        <label className="mt-4 block">
          <span className="sr-only">Trade timeline</span>
          <input
            type="range"
            min={0}
            max={frames.length - 1}
            value={index}
            onChange={(event) => goTo(Number(event.target.value))}
            aria-valuetext={`Step ${index + 1}: ${steps[index]?.title ?? ''}`}
            className="w-full accent-protected"
          />
        </label>
        <div className="flex justify-between text-[11px] text-muted">
          <span>Trade begins</span>
          <span>Verification and outcome</span>
        </div>
      </div>
    </section>
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
  selected,
  onSelect,
}: {
  party: Party;
  active: boolean;
  balance: { amount: string; pool: Pool } | null;
  scale: bigint;
  selected: boolean;
  onSelect: () => void;
}) {
  const node = NODES[party];
  const filled = balance === null ? 0 : Number((BigInt(balance.amount) * 134n) / scale);
  const amountLabel = balance === null ? null : `${formatUsdcUnits(balance.amount)} USDC`;
  const colour =
    party === 'buyer' || party === 'escrow' ? POOL_COLOUR.protected : POOL_COLOUR.advance;
  const metricLabel =
    party === 'escrow'
      ? 'PROTECTED NOW'
      : party === 'supplier'
        ? 'RECEIVED SO FAR'
        : party === 'funder'
          ? 'CAPITAL AT RISK'
          : 'RETURNED';

  return (
    <g
      transform={`translate(${node.x} ${node.y})`}
      data-testid={`flow-node-${party}`}
      role="button"
      tabIndex={0}
      aria-label={node.label + ': ' + ROLE_EXPLANATION[party]}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
      style={{ cursor: 'pointer' }}
    >
      <rect
        x={-85}
        y={-48}
        width={170}
        height={96}
        rx={14}
        fill={active || selected ? '#213854' : '#16243a'}
        stroke={colour}
        strokeOpacity={active || selected ? 0.95 : 0.36}
        strokeWidth={active || selected ? 2.5 : 1.5}
        style={{ transition: 'fill 350ms, stroke-opacity 350ms' }}
      />
      <circle cx={68} cy={-31} r={4} fill={active ? colour : '#64748b'} />
      <text x={-69} y={-17} fill="#f8fafc" fontSize={16} fontWeight={700}>
        {node.label}
      </text>
      <text x={-69} y={-1} fill="#9baec5" fontSize={10}>
        {node.sub}
      </text>
      {balance !== null && (
        <>
          <text x={-69} y={17} fill="#9baec5" fontSize={9} letterSpacing={1.2}>
            {metricLabel}
          </text>
          <text
            x={-69}
            y={36}
            fill="#ffffff"
            fontSize={17}
            fontWeight={700}
            textLength={amountLabel !== null && amountLabel.length > 13 ? 134 : undefined}
            lengthAdjust="spacingAndGlyphs"
          >
            {amountLabel}
          </text>
          <rect x={-69} y={40} width={134} height={4} rx={2} fill="#34465e" />
          <rect
            x={-69}
            y={40}
            width={Math.max(0, Math.min(134, filled))}
            height={4}
            rx={2}
            fill={POOL_COLOUR[balance.pool]}
            style={{ transition: 'width 700ms ease-out' }}
          />
        </>
      )}
      {balance === null && (
        <text x={-69} y={32} fill="#b7c6d8" fontSize={12}>
          Funds the milestone
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
  delay,
  still,
}: {
  path: string;
  colour: string;
  amount: string;
  delay: number;
  still: boolean;
}) {
  if (still) return null;
  return (
    <g data-testid="flow-coin" data-amount={amount} aria-hidden="true">
      <g>
        <animateMotion dur="2.3s" begin={`${delay}s`} fill="freeze" path={path} />
        <circle r={18} fill={colour} opacity={0.25} />
        <circle r={12} fill={colour} />
        <circle r={4} fill="#ffffff" opacity={0.9} />
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

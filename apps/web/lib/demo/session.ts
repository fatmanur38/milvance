import type { OrderWithMilestones } from '../api/schemas';
import { templateById } from './templates';

/**
 * Local Trade Lab bookkeeping.
 *
 * This remembers ONE thing that the chain cannot: which template someone was
 * following when they started a trade. Stage names are off-chain wording, so
 * without this the lab could not say "milestone 2 is the Shipment stage".
 *
 * It is per-browser, it is not authoritative, and nothing financial is stored
 * or read back from it. Every amount, status and transaction in the lab comes
 * from the read model. Clearing it loses some wording and nothing else.
 */

export const RUNS_KEY = 'milvance:trade-lab:runs';

/** Cap: a booth laptop should not accumulate an unbounded list. */
const MAX_RUNS = 25;

export interface DemoRun {
  readonly orderId: string;
  readonly templateId: string;
  /** ISO timestamp, local bookkeeping only. */
  readonly startedAt: string;
}

/** The slice of `Storage` used here. Browser storage can throw, so it is optional. */
export interface RunStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const CHAIN_ID = /^[1-9]\d{0,19}$/;

function isRun(value: unknown): value is DemoRun {
  if (typeof value !== 'object' || value === null) return false;
  const run = value as Record<string, unknown>;
  return (
    typeof run.orderId === 'string' &&
    CHAIN_ID.test(run.orderId) &&
    typeof run.templateId === 'string' &&
    templateById(run.templateId) !== null &&
    typeof run.startedAt === 'string'
  );
}

/** Runs recorded in this browser. Corrupt or foreign data reads as empty. */
export function readRuns(store: RunStore | undefined): DemoRun[] {
  if (store === undefined) return [];
  let raw: string | null;
  try {
    raw = store.getItem(RUNS_KEY);
  } catch {
    return [];
  }
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRun).slice(0, MAX_RUNS);
  } catch {
    return [];
  }
}

function write(store: RunStore | undefined, runs: readonly DemoRun[]): DemoRun[] {
  const capped = runs.slice(0, MAX_RUNS);
  if (store === undefined) return [...capped];
  try {
    store.setItem(RUNS_KEY, JSON.stringify(capped));
  } catch {
    // Private mode, blocked storage, or a full quota. The lab still works; it
    // just forgets which template a trade followed.
  }
  return [...capped];
}

/**
 * Remembers which template a trade followed.
 *
 * Attaching is idempotent per order, and re-attaching moves the run to the top
 * without inventing a second entry for the same chain order.
 */
export function attachRun(
  store: RunStore | undefined,
  run: { orderId: string; templateId: string; startedAt?: string },
): DemoRun[] {
  if (!CHAIN_ID.test(run.orderId) || templateById(run.templateId) === null) {
    return readRuns(store);
  }
  const existing = readRuns(store).filter((candidate) => candidate.orderId !== run.orderId);
  const entry: DemoRun = {
    orderId: run.orderId,
    templateId: run.templateId,
    startedAt: run.startedAt ?? new Date().toISOString(),
  };
  return write(store, [entry, ...existing]);
}

/**
 * Drops one run from this browser's list.
 *
 * The order stays exactly as it is on chain: this removes a note about which
 * template it followed, nothing more. It cannot delete a trade, cannot move
 * money and cannot change a status.
 */
export function forgetRun(store: RunStore | undefined, orderId: string): DemoRun[] {
  return write(
    store,
    readRuns(store).filter((run) => run.orderId !== orderId),
  );
}

/** Clears the local list. Chain state is untouched by construction. */
export function clearRuns(store: RunStore | undefined): DemoRun[] {
  if (store !== undefined) {
    try {
      store.removeItem(RUNS_KEY);
    } catch {
      // Nothing to do: the list is advisory.
    }
  }
  return [];
}

export interface RestartGuidance {
  /** Always false. A trade on chain is history and is never rewound. */
  readonly canReuse: false;
  /** What the lab will do instead. */
  readonly action: 'start-new-trade';
  readonly reason: string;
}

/**
 * What "run it again" means for a trade that already exists.
 *
 * Never a reset. Soroban state is immutable history: a settled milestone stays
 * settled, a refunded one stays refunded, and an order that has been accepted
 * can never return to draft — the contract has no such transition, and faking
 * one in the read model would be inventing financial history.
 *
 * So a repeat demo is a NEW trade, which produces new, real chain state. The
 * only thing that is ever cleared is this browser's list.
 */
export function restartGuidance(order: OrderWithMilestones): RestartGuidance {
  const settledOrRefunded = order.milestones.some(
    (milestone) => milestone.status === 'SETTLED' || milestone.status === 'REFUNDED',
  );
  if (order.status === 'COMPLETED' || settledOrRefunded) {
    return {
      canReuse: false,
      action: 'start-new-trade',
      reason:
        'This trade has finished on Stellar. Settled and refunded milestones are permanent, so a fresh run creates a new trade rather than rewinding this one.',
    };
  }
  if (order.status === 'CANCELLED') {
    return {
      canReuse: false,
      action: 'start-new-trade',
      reason: 'This trade was cancelled on Stellar. A cancelled order cannot be reopened.',
    };
  }
  if (order.status === 'ACTIVE') {
    return {
      canReuse: false,
      action: 'start-new-trade',
      reason:
        'The supplier has accepted this trade, so its milestone set is fixed on Stellar. Continue it, or start a separate trade for a fresh run.',
    };
  }
  return {
    canReuse: false,
    action: 'start-new-trade',
    reason:
      'This trade is still a draft. You can keep adding milestones to it, or start a separate trade for a fresh run.',
  };
}

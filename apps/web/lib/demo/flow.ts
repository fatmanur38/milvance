import type { TourStep } from './tour';

/**
 * The trade as money moving between parties, derived from the same real events
 * the tour narrates.
 *
 * This exists because the most important fact about Milvance is almost
 * impossible to say in a sentence and obvious in a picture: the buyer's
 * protected money and the funder's advance are two different pools, from two
 * different people, travelling two different paths. Prose makes a reader take
 * that on trust. An animation lets them watch the funder's money go straight
 * to the supplier while the escrow sits untouched.
 *
 * Nothing here invents a number. Every transfer and every balance below is
 * computed from an indexed contract event, in exact base units.
 */

export type Party = 'buyer' | 'escrow' | 'supplier' | 'funder';

/** Which pool a moving amount belongs to. They are never drawn the same. */
export type Pool = 'protected' | 'advance';

export interface Transfer {
  readonly from: Party;
  readonly to: Party;
  /** Exact USDC base units. */
  readonly amount: string;
  readonly pool: Pool;
  /** Shown on the moving amount, e.g. "repaid first". */
  readonly label: string;
}

export interface Balances {
  /** Buyer money the contract is holding right now. */
  readonly escrow: string;
  /** USDC the supplier has actually received. */
  readonly supplier: string;
  /** Funder money currently out in the world, not yet repaid. */
  readonly funderExposed: string;
  /** Cumulative escrow returned to the buyer. */
  readonly buyerRefunded: string;
}

export interface FlowFrame {
  /** Ties the frame to its narrated step, and so to its transaction. */
  readonly stepId: string;
  /**
   * Transfers that happen in this ONE transaction. More than one means they
   * were atomic — which is the whole point of the settlement frame.
   */
  readonly transfers: readonly Transfer[];
  /** Balances after this frame. */
  readonly balances: Balances;
  /** Parties to emphasise even when no money moves, e.g. the attestor's step. */
  readonly active: readonly Party[];
}

const ZERO: Balances = { escrow: '0', supplier: '0', funderExposed: '0', buyerRefunded: '0' };

function add(value: string, delta: bigint): string {
  return (BigInt(value) + delta).toString();
}

/**
 * Turns narrated steps into frames of moving money.
 *
 * Driven by `amountMeans` rather than by the event name, so a step can only
 * move money if the narration already said money moved — the picture and the
 * words cannot drift apart.
 */
export function buildFlow(steps: readonly TourStep[]): readonly FlowFrame[] {
  let balances = ZERO;
  const frames: FlowFrame[] = [];

  for (const step of steps) {
    let transfers: readonly Transfer[] = [];
    let active: readonly Party[];

    switch (step.amountMeans) {
      case 'protected': {
        const amount = step.amount ?? '0';
        transfers = [
          { from: 'buyer', to: 'escrow', amount, pool: 'protected', label: 'protected' },
        ];
        balances = { ...balances, escrow: add(balances.escrow, BigInt(amount)) };
        active = ['buyer', 'escrow'];
        break;
      }
      case 'advanced': {
        const amount = step.amount ?? '0';
        // Straight from the funder to the supplier. It never enters escrow,
        // and the drawing must never let it look as though it did.
        transfers = [
          { from: 'funder', to: 'supplier', amount, pool: 'advance', label: 'their own money' },
        ];
        balances = {
          ...balances,
          supplier: add(balances.supplier, BigInt(amount)),
          funderExposed: add(balances.funderExposed, BigInt(amount)),
        };
        active = ['funder', 'supplier'];
        break;
      }
      case 'repaid': {
        // Settlement: one transaction, two movements, funder first.
        const released = BigInt(step.amount ?? '0');
        const toFunder = BigInt(step.settlement?.funderRepayment ?? '0');
        const toSupplier = BigInt(step.settlement?.supplierPayout ?? '0');
        transfers = [
          ...(toFunder > 0n
            ? [
                {
                  from: 'escrow' as const,
                  to: 'funder' as const,
                  amount: toFunder.toString(),
                  pool: 'protected' as const,
                  label: 'repaid first',
                },
              ]
            : []),
          ...(toSupplier > 0n
            ? [
                {
                  from: 'escrow' as const,
                  to: 'supplier' as const,
                  amount: toSupplier.toString(),
                  pool: 'protected' as const,
                  label: 'the remainder',
                },
              ]
            : []),
        ];
        balances = {
          escrow: add(balances.escrow, -released),
          supplier: add(balances.supplier, toSupplier),
          // The funder is made whole, so their exposure closes.
          funderExposed: '0',
          buyerRefunded: balances.buyerRefunded,
        };
        active = ['escrow', 'funder', 'supplier'];
        break;
      }
      case 'refunded': {
        const amount = BigInt(step.amount ?? '0');
        transfers = [
          {
            from: 'escrow',
            to: 'buyer',
            amount: amount.toString(),
            pool: 'protected',
            label: 'returned',
          },
        ];
        balances = {
          ...balances,
          escrow: add(balances.escrow, -amount),
          buyerRefunded: add(balances.buyerRefunded, amount),
        };
        active = ['escrow', 'buyer'];
        break;
      }
      default:
        active = partiesFor(step);
        break;
    }

    frames.push({ stepId: step.id, transfers, balances, active });
  }

  return frames;
}

/** Who to emphasise on a step that moves no money. */
function partiesFor(step: TourStep): Party[] {
  switch (step.actor) {
    case 'Buyer':
      return ['buyer'];
    case 'Supplier':
      return ['supplier'];
    case 'Funder':
      return ['funder'];
    case 'Attestor':
    case 'Resolver':
    case 'Contract':
      return ['escrow'];
    default:
      return [];
  }
}

/**
 * The largest amount any single frame shows.
 *
 * Used to scale the pool meters so the two pools stay comparable to each other
 * rather than each filling its own bar — a chart where 8 and 10 both look full
 * would undo the point the picture is making.
 */
export function flowScale(frames: readonly FlowFrame[]): bigint {
  let largest = 1n;
  for (const frame of frames) {
    for (const value of [
      frame.balances.escrow,
      frame.balances.supplier,
      frame.balances.funderExposed,
      frame.balances.buyerRefunded,
    ]) {
      if (BigInt(value) > largest) largest = BigInt(value);
    }
  }
  return largest;
}

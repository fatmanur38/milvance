import { compareUnits, parseUsdcInput } from '../domain/amounts';

/**
 * Trade templates: suggested wording and amounts for a demo trade.
 *
 * A template is PREPARATION MATERIAL, nothing more. It never signs, never
 * submits and never becomes chain state on its own — a buyer types the
 * suggested amount into the ordinary milestone form and their wallet signs it,
 * exactly as in the normal workspace.
 *
 * Stage names live here and only here. MilvanceCore has no name field on a
 * milestone: it knows an index, an amount, an optional date and a status. The
 * stage name is how humans talk about milestone 1; it is not on chain, so the
 * interface must never present it as if the contract enforced it.
 */

export interface TemplateMilestone {
  /** Human stage name. Off-chain wording, never a contract field. */
  readonly stage: string;
  /** Suggested protected payment, as typed into the form (e.g. "2"). */
  readonly amount: string;
  /** What this stage means in the trade. */
  readonly meaning: string;
  /** Evidence a supplier would realistically submit for it. */
  readonly evidence: string;
}

export interface TemplateFinancing {
  /** Suggested working capital the supplier asks for. */
  readonly principal: string;
  /** Suggested repayment out of protected escrow on verification. */
  readonly repayment: string;
  /** Which milestone (1-based, as shown in the UI) the example applies to. */
  readonly milestone: number;
}

export interface TradeTemplate {
  readonly id: string;
  readonly name: string;
  /** One line for the picker. */
  readonly summary: string;
  /** Why this shape of trade exists in the real world. */
  readonly story: string;
  /** Roughly how long a demo run takes, in minutes. */
  readonly minutes: number;
  readonly milestones: readonly TemplateMilestone[];
  readonly financing: TemplateFinancing;
}

/**
 * The fast one, for a queue at a conference booth (AGENT.md §28).
 *
 * Small amounts so a stranger can finish a real Testnet trade in a few minutes
 * without needing much faucet USDC.
 */
const FAST_TASK: TradeTemplate = {
  id: 'fast-task',
  name: 'Review my landing page',
  summary: 'Two small milestones, 5 USDC total — a full run in a few minutes.',
  story:
    'A one-person studio hires a reviewer. It is deliberately tiny, but it moves real Testnet USDC through the same contract as a container of goods.',
  minutes: 5,
  milestones: [
    {
      stage: 'Review',
      amount: '2',
      meaning: 'The reviewer goes through the page and writes up what they found.',
      evidence: 'The written review, as a PDF or text file.',
    },
    {
      stage: 'Feedback call',
      amount: '3',
      meaning: 'A call to walk through the findings and agree what changes first.',
      evidence: 'Call notes, or a short summary both sides agreed on.',
    },
  ],
  financing: { milestone: 1, principal: '1', repayment: '1.5' },
};

/**
 * The commercial one, for judges (AGENT.md §28): the same state machine over a
 * long cross-border trust window, where the supplier's cash gap is the point.
 */
const CROSS_BORDER: TradeTemplate = {
  id: 'cross-border-manufacturing',
  name: 'Cross-border manufacturing order',
  summary: 'Production, shipment and delivery — the trade the product exists for.',
  story:
    'An importer orders goods from a supplier abroad. The buyer will not prepay a factory they cannot inspect, and the supplier cannot fund production for the weeks the goods spend in transit. Each stage is protected separately, and the supplier can raise working capital against a protected stage instead of waiting for delivery.',
  minutes: 12,
  milestones: [
    {
      stage: 'Production and QC',
      amount: '10',
      meaning: 'Goods are manufactured and pass quality control before they ship.',
      evidence: 'QC report or inspection photos.',
    },
    {
      stage: 'Shipment',
      amount: '6',
      meaning: 'Goods are handed to the carrier and leave the country of origin.',
      evidence: 'Bill of lading or carrier receipt.',
    },
    {
      stage: 'Delivery',
      amount: '4',
      meaning: 'Goods arrive and the buyer confirms what was received.',
      evidence: 'Delivery confirmation signed at destination.',
    },
  ],
  financing: { milestone: 1, principal: '8', repayment: '9' },
};

export const TRADE_TEMPLATES: readonly TradeTemplate[] = [FAST_TASK, CROSS_BORDER];

export const DEFAULT_TEMPLATE_ID = FAST_TASK.id;

/** A template by id, or null. Ids arrive from URLs, so nothing is trusted. */
export function templateById(id: string | null | undefined): TradeTemplate | null {
  if (id === null || id === undefined) return null;
  return TRADE_TEMPLATES.find((template) => template.id === id) ?? null;
}

export interface TemplateProblem {
  readonly templateId: string;
  readonly problem: string;
}

/**
 * Checks every shipped template against the contract's own rules, so a bad
 * default can never send someone into a guaranteed rejection:
 *
 *   - amounts must parse as USDC and be > 0 (`Error::InvalidAmount`),
 *   - at most 20 milestones per order (`MAX_MILESTONES_PER_ORDER`),
 *   - requested principal < protected amount, leaving room to repay
 *     (`request_finance`: `requested_principal > funded_amount` is rejected,
 *     and the UI requires strictly less so a repayment can exceed it),
 *   - repayment ≥ principal and ≤ the protected amount
 *     (`Error::RepaymentExceedsEscrow`).
 *
 * Returns every problem found; an empty array means the shipped set is sound.
 */
export function templateProblems(
  templates: readonly TradeTemplate[] = TRADE_TEMPLATES,
): TemplateProblem[] {
  const problems: TemplateProblem[] = [];
  const report = (templateId: string, problem: string): void => {
    problems.push({ templateId, problem });
  };

  const seen = new Set<string>();
  for (const template of templates) {
    if (seen.has(template.id)) report(template.id, 'Duplicate template id.');
    seen.add(template.id);

    if (template.milestones.length === 0) {
      report(template.id, 'A template needs at least one milestone.');
    }
    if (template.milestones.length > 20) {
      report(template.id, 'A template cannot exceed the contract limit of 20 milestones.');
    }

    for (const milestone of template.milestones) {
      const parsed = parseUsdcInput(milestone.amount);
      if (!parsed.ok) report(template.id, `${milestone.stage}: ${parsed.error}`);
      if (milestone.stage.trim() === '') report(template.id, 'A milestone stage needs a name.');
    }

    const { financing } = template;
    const target = template.milestones[financing.milestone - 1];
    if (target === undefined) {
      report(template.id, 'The financing example points at a milestone that does not exist.');
      continue;
    }
    const protectedAmount = parseUsdcInput(target.amount);
    const principal = parseUsdcInput(financing.principal);
    const repayment = parseUsdcInput(financing.repayment);
    if (!protectedAmount.ok || !principal.ok || !repayment.ok) {
      report(template.id, 'The financing example does not parse as USDC.');
      continue;
    }
    if (compareUnits(principal.units, protectedAmount.units) >= 0) {
      report(template.id, 'Working capital must be less than the protected milestone amount.');
    }
    if (compareUnits(repayment.units, principal.units) < 0) {
      report(template.id, 'Repayment cannot be below the principal advanced.');
    }
    if (compareUnits(repayment.units, protectedAmount.units) > 0) {
      report(template.id, 'Repayment cannot exceed the protected milestone amount.');
    }
  }
  return problems;
}

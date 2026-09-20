import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TEMPLATE_ID,
  templateById,
  templateProblems,
  TRADE_TEMPLATES,
  type TradeTemplate,
} from './templates';

const base = (overrides: Partial<TradeTemplate> = {}): TradeTemplate => ({
  id: 'probe',
  name: 'Probe',
  summary: 'x',
  story: 'x',
  minutes: 5,
  milestones: [{ stage: 'One', amount: '10', meaning: 'x', evidence: 'x' }],
  financing: { milestone: 1, principal: '8', repayment: '9' },
  ...overrides,
});

describe('trade templates', () => {
  it('ships templates the contract will actually accept', () => {
    // A template that violates a contract guard sends a demo straight into a
    // rejection in front of an audience.
    expect(templateProblems()).toEqual([]);
    expect(templateById(DEFAULT_TEMPLATE_ID)).not.toBeNull();
    expect(TRADE_TEMPLATES.length).toBeGreaterThanOrEqual(2);
  });

  it('covers both the fast task and a commercial trade', () => {
    // AGENT.md §28: a tiny task for a booth queue, and a Production/Shipment/
    // Delivery order so judges see the long trust window.
    const stages = TRADE_TEMPLATES.flatMap((template) =>
      template.milestones.map((milestone) => milestone.stage.toLowerCase()),
    );
    expect(stages.some((stage) => stage.includes('production'))).toBe(true);
    expect(stages.some((stage) => stage.includes('shipment'))).toBe(true);
    expect(stages.some((stage) => stage.includes('delivery'))).toBe(true);
    expect(TRADE_TEMPLATES.some((template) => template.milestones.length === 2)).toBe(true);
  });

  it('rejects an unknown template id rather than guessing', () => {
    expect(templateById('nope')).toBeNull();
    expect(templateById(null)).toBeNull();
    expect(templateById(undefined)).toBeNull();
    expect(templateById('../../etc/passwd')).toBeNull();
  });

  it('catches working capital that leaves no room to repay', () => {
    // request_finance rejects a principal above the protected amount, and the
    // workspace requires strictly less so a repayment can exceed it.
    const problems = templateProblems([
      base({ financing: { milestone: 1, principal: '10', repayment: '10' } }),
    ]);
    expect(problems.map((problem) => problem.problem)).toContain(
      'Working capital must be less than the protected milestone amount.',
    );
  });

  it('catches a repayment the escrow could never cover', () => {
    // Error::RepaymentExceedsEscrow.
    const problems = templateProblems([
      base({ financing: { milestone: 1, principal: '8', repayment: '11' } }),
    ]);
    expect(problems.map((problem) => problem.problem)).toContain(
      'Repayment cannot exceed the protected milestone amount.',
    );
  });

  it('catches a repayment below the principal', () => {
    const problems = templateProblems([
      base({ financing: { milestone: 1, principal: '8', repayment: '7' } }),
    ]);
    expect(problems.map((problem) => problem.problem)).toContain(
      'Repayment cannot be below the principal advanced.',
    );
  });

  it('catches amounts that are not USDC', () => {
    const problems = templateProblems([
      base({ milestones: [{ stage: 'One', amount: '0', meaning: 'x', evidence: 'x' }] }),
    ]);
    expect(problems).not.toEqual([]);
    const tooPrecise = templateProblems([
      base({ milestones: [{ stage: 'One', amount: '1.123456789', meaning: 'x', evidence: 'x' }] }),
    ]);
    expect(tooPrecise).not.toEqual([]);
  });

  it('catches a financing example pointing at a milestone that does not exist', () => {
    const problems = templateProblems([
      base({ financing: { milestone: 4, principal: '1', repayment: '1' } }),
    ]);
    expect(problems.map((problem) => problem.problem)).toContain(
      'The financing example points at a milestone that does not exist.',
    );
  });

  it('catches more milestones than the contract allows', () => {
    const many = Array.from({ length: 21 }, (_, index) => ({
      stage: `Stage ${index}`,
      amount: '1',
      meaning: 'x',
      evidence: 'x',
    }));
    const problems = templateProblems([
      base({ milestones: many, financing: { milestone: 1, principal: '0.5', repayment: '0.6' } }),
    ]);
    expect(problems.map((problem) => problem.problem)).toContain(
      'A template cannot exceed the contract limit of 20 milestones.',
    );
  });

  it('catches duplicate ids', () => {
    expect(templateProblems([base(), base()]).map((problem) => problem.problem)).toContain(
      'Duplicate template id.',
    );
  });
});

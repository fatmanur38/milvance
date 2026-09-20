import { describe, expect, it } from 'vitest';

import { milestone, order } from '../test/fixtures';
import {
  attachRun,
  clearRuns,
  forgetRun,
  readRuns,
  restartGuidance,
  RUNS_KEY,
  type RunStore,
} from './session';

function memoryStore(initial?: string): RunStore & { raw: () => string | null } {
  let value: string | null = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next;
    },
    removeItem: () => {
      value = null;
    },
    raw: () => value,
  };
}

describe('the lab’s local notes', () => {
  it('remembers which template a trade followed', () => {
    const store = memoryStore();
    const runs = attachRun(store, { orderId: '7', templateId: 'fast-task' });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.orderId).toBe('7');
    expect(readRuns(store)[0]?.templateId).toBe('fast-task');
  });

  it('keeps one note per trade, newest first', () => {
    const store = memoryStore();
    attachRun(store, { orderId: '7', templateId: 'fast-task' });
    attachRun(store, { orderId: '8', templateId: 'cross-border-manufacturing' });
    const runs = attachRun(store, { orderId: '7', templateId: 'cross-border-manufacturing' });
    expect(runs.map((run) => run.orderId)).toEqual(['7', '8']);
    expect(runs[0]?.templateId).toBe('cross-border-manufacturing');
  });

  it('refuses notes for impossible orders or unknown templates', () => {
    const store = memoryStore();
    expect(attachRun(store, { orderId: '0', templateId: 'fast-task' })).toEqual([]);
    expect(attachRun(store, { orderId: 'abc', templateId: 'fast-task' })).toEqual([]);
    expect(attachRun(store, { orderId: '7', templateId: 'made-up' })).toEqual([]);
  });

  it('reads corrupt or foreign storage as empty rather than throwing', () => {
    expect(readRuns(memoryStore('not json'))).toEqual([]);
    expect(readRuns(memoryStore('{"orderId":"7"}'))).toEqual([]);
    expect(readRuns(memoryStore('[{"orderId":"7","templateId":"nope","startedAt":"x"}]'))).toEqual(
      [],
    );
    expect(readRuns(undefined)).toEqual([]);
  });

  it('survives storage that throws, as a private window does', () => {
    const hostile: RunStore = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readRuns(hostile)).toEqual([]);
    expect(() => attachRun(hostile, { orderId: '7', templateId: 'fast-task' })).not.toThrow();
    expect(() => clearRuns(hostile)).not.toThrow();
  });

  it('forgets a note without touching anything else', () => {
    const store = memoryStore();
    attachRun(store, { orderId: '7', templateId: 'fast-task' });
    attachRun(store, { orderId: '8', templateId: 'fast-task' });
    expect(forgetRun(store, '7').map((run) => run.orderId)).toEqual(['8']);
    expect(clearRuns(store)).toEqual([]);
    expect(store.raw()).toBeNull();
    expect(store.getItem(RUNS_KEY)).toBeNull();
  });
});

describe('running a demo again', () => {
  it('never rewinds a finished trade', () => {
    const settled = restartGuidance(
      order({ status: 'COMPLETED', milestones: [milestone({ status: 'SETTLED' })] }),
    );
    expect(settled.canReuse).toBe(false);
    expect(settled.action).toBe('start-new-trade');
    expect(settled.reason).toMatch(/permanent/i);
  });

  it('never rewinds a refunded milestone', () => {
    const refunded = restartGuidance(
      order({ status: 'ACTIVE', milestones: [milestone({ status: 'REFUNDED' })] }),
    );
    expect(refunded.canReuse).toBe(false);
    expect(refunded.action).toBe('start-new-trade');
  });

  it('never reopens a cancelled trade', () => {
    const cancelled = restartGuidance(order({ status: 'CANCELLED', milestones: [] }));
    expect(cancelled.canReuse).toBe(false);
    expect(cancelled.reason).toMatch(/cannot be reopened/i);
  });

  it('will not turn an accepted trade back into a draft', () => {
    const active = restartGuidance(order({ status: 'ACTIVE', milestones: [milestone()] }));
    expect(active.canReuse).toBe(false);
    expect(active.action).toBe('start-new-trade');
    expect(active.reason).toMatch(/fixed on Stellar/i);
  });

  it('offers a fresh trade even for a draft', () => {
    const draft = restartGuidance(order({ status: 'CREATED', milestones: [] }));
    expect(draft.canReuse).toBe(false);
    expect(draft.action).toBe('start-new-trade');
  });
});

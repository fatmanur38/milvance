import { describe, expect, it } from 'vitest';

import { milestone, order, WALLETS } from '../test/fixtures';
import { attentionItems } from './attention';

describe('what needs this wallet', () => {
  it('asks the attestor, and only the attestor, to verify submitted evidence', () => {
    const orders = [order({ milestones: [milestone({ status: 'SUBMITTED' })] })];
    expect(attentionItems(WALLETS.attestor, orders).map((item) => item.role)).toEqual(['attestor']);
    expect(attentionItems(WALLETS.resolver, orders)).toEqual([]);
    expect(attentionItems(WALLETS.buyer, orders)).toEqual([]);
  });

  it('asks the resolver to resolve a disputed milestone', () => {
    const orders = [order({ milestones: [milestone({ status: 'DISPUTED' })] })];
    expect(attentionItems(WALLETS.resolver, orders)[0]?.title).toMatch(/Resolve the dispute/);
  });

  it('prompts the supplier to accept a drafted order', () => {
    const orders = [order({ status: 'CREATED' })];
    expect(attentionItems(WALLETS.supplier, orders)[0]?.title).toMatch(/accept the order/);
  });

  it('points the supplier at converting an advance', () => {
    const orders = [order({ milestones: [milestone({ status: 'FINANCED' })] })];
    expect(attentionItems(WALLETS.supplier, orders)[0]?.title).toMatch(/convert to TRY/);
  });

  it('has nothing for a disconnected visitor or an outsider', () => {
    const orders = [order({ milestones: [milestone({ status: 'SUBMITTED' })] })];
    expect(attentionItems(undefined, orders)).toEqual([]);
    expect(attentionItems(WALLETS.outsider, orders)).toEqual([]);
  });
});

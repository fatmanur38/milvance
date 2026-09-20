import { describe, expect, it } from 'vitest';

import { finance, milestone, offer, openRequest, order, position, WALLETS } from '../test/fixtures';
import { milestoneActions, orderActions, type MilestoneAction } from './actions';

const kinds = (actions: MilestoneAction[]) => actions.map((action) => action.kind);
const NOW = new Date('2026-09-20T00:00:00.000Z');
const PAST = '2026-09-01T00:00:00.000Z';

describe('order-level actions', () => {
  const draft = order({ status: 'CREATED', milestones: [] });

  it('lets the buyer add milestones and cancel a draft order', () => {
    expect(orderActions(WALLETS.buyer, draft)).toEqual(['create-milestone', 'cancel-order']);
  });

  it('lets the supplier accept only once a milestone exists', () => {
    expect(orderActions(WALLETS.supplier, draft)).toEqual([]);
    expect(orderActions(WALLETS.supplier, order({ status: 'CREATED' }))).toEqual(['accept-order']);
  });

  it('offers nothing once the order is active', () => {
    expect(orderActions(WALLETS.buyer, order())).toEqual([]);
  });
});

describe('buyer: protected milestone money', () => {
  it('offers funding for an unfunded milestone', () => {
    const m = milestone({ status: 'UNFUNDED', fundedAmount: '0', fullyFunded: false });
    expect(
      kinds(milestoneActions(WALLETS.buyer, order({ milestones: [m] }), m, finance())),
    ).toEqual(['fund-milestone']);
  });

  it('offers unwinding only when a partial deposit exists', () => {
    const m = milestone({ status: 'UNFUNDED', fundedAmount: '5000000000', fullyFunded: false });
    expect(kinds(milestoneActions(WALLETS.buyer, order(), m, finance()))).toEqual([
      'fund-milestone',
      'cancel-partial-funding',
    ]);
  });
});

describe('supplier: working capital', () => {
  it('can request working capital only against a fully protected milestone', () => {
    expect(kinds(milestoneActions(WALLETS.supplier, order(), milestone(), finance()))).toContain(
      'request-finance',
    );
    const partial = milestone({ status: 'UNFUNDED', fundedAmount: '1', fullyFunded: false });
    expect(kinds(milestoneActions(WALLETS.supplier, order(), partial, finance()))).not.toContain(
      'request-finance',
    );
  });

  it('compares live offers and can accept one of them', () => {
    const m = milestone({ status: 'FINANCE_REQUESTED' });
    const f = finance({
      request: openRequest(),
      offers: [offer({ offerId: '1' }), offer({ offerId: '2', expiresAt: PAST })],
    });
    const actions = milestoneActions(WALLETS.supplier, order(), m, f, NOW);
    // The expired offer is not offered: the contract would reject it (OfferExpired).
    expect(actions.filter((a) => a.kind === 'accept-offer').map((a) => a.offerId)).toEqual(['1']);
    expect(kinds(actions)).toContain('cancel-finance-request');
  });

  it('can release an accepted offer only after it expired unfunded', () => {
    const m = milestone({ status: 'FINANCE_REQUESTED' });
    const live = finance({
      request: { ...openRequest(), status: 'ACCEPTED' },
      offers: [offer({ status: 'ACCEPTED' })],
    });
    expect(kinds(milestoneActions(WALLETS.supplier, order(), m, live, NOW))).not.toContain(
      'release-expired-acceptance',
    );
    const lapsed = finance({
      request: { ...openRequest(), status: 'ACCEPTED' },
      offers: [offer({ status: 'ACCEPTED', expiresAt: PAST })],
    });
    expect(kinds(milestoneActions(WALLETS.supplier, order(), m, lapsed, NOW))).toContain(
      'release-expired-acceptance',
    );
  });
});

describe('funder: independent capital', () => {
  const m = milestone({ status: 'FINANCE_REQUESTED' });

  it('lets an independent wallet make an offer on a live request', () => {
    const f = finance({ request: openRequest() });
    expect(kinds(milestoneActions(WALLETS.funder, order(), m, f, NOW))).toEqual(['make-offer']);
  });

  it('does not invite an offer on an expired request', () => {
    const f = finance({ request: openRequest(PAST) });
    expect(kinds(milestoneActions(WALLETS.funder, order(), m, f, NOW))).toEqual([]);
  });

  it('lets only the offer owner withdraw it', () => {
    const f = finance({ request: openRequest(), offers: [offer()] });
    expect(kinds(milestoneActions(WALLETS.funder, order(), m, f, NOW))).toContain('cancel-offer');
    expect(kinds(milestoneActions(WALLETS.outsider, order(), m, f, NOW))).not.toContain(
      'cancel-offer',
    );
  });

  it('lets only the SELECTED funder fund the advance', () => {
    const f = finance({
      request: { ...openRequest(), status: 'ACCEPTED' },
      offers: [offer({ status: 'ACCEPTED' })],
    });
    expect(kinds(milestoneActions(WALLETS.funder, order(), m, f, NOW))).toEqual(['fund-advance']);
    expect(kinds(milestoneActions(WALLETS.outsider, order(), m, f, NOW))).toEqual([]);
  });
});

describe('evidence, verification, settlement and disputes', () => {
  it('only the assigned attestor may verify, and only once evidence is in', () => {
    const m = milestone({ status: 'SUBMITTED', evidenceHash: 'b'.repeat(64) });
    expect(kinds(milestoneActions(WALLETS.attestor, order(), m, finance()))).toEqual([
      'verify-milestone',
    ]);
    expect(kinds(milestoneActions(WALLETS.funder, order(), m, finance()))).not.toContain(
      'verify-milestone',
    );
  });

  it('lets the supplier or the active funder release a verified milestone', () => {
    const m = milestone({ status: 'VERIFIED' });
    const f = finance({ positions: [position()] });
    expect(kinds(milestoneActions(WALLETS.supplier, order(), m, f))).toContain('settle-milestone');
    expect(kinds(milestoneActions(WALLETS.funder, order(), m, f))).toContain('settle-milestone');
    expect(kinds(milestoneActions(WALLETS.buyer, order(), m, f))).not.toContain('settle-milestone');
  });

  it('lets only buyer or supplier open a dispute', () => {
    const m = milestone({ status: 'SUBMITTED', evidenceHash: 'b'.repeat(64) });
    expect(kinds(milestoneActions(WALLETS.buyer, order(), m, finance()))).toContain('open-dispute');
    expect(kinds(milestoneActions(WALLETS.attestor, order(), m, finance()))).not.toContain(
      'open-dispute',
    );
  });

  it('only the assigned resolver sees the resolution decision', () => {
    const m = milestone({ status: 'DISPUTED' });
    expect(kinds(milestoneActions(WALLETS.resolver, order(), m, finance()))).toEqual([
      'resolve-dispute',
    ]);
    expect(kinds(milestoneActions(WALLETS.buyer, order(), m, finance()))).toEqual([]);
  });
});

describe('what an unrelated or absent wallet sees', () => {
  it.each([
    ['UNFUNDED'],
    ['FUNDED'],
    ['FINANCED'],
    ['SUBMITTED'],
    ['VERIFIED'],
    ['DISPUTED'],
    ['SETTLED'],
  ] as const)('an outsider is offered nothing on a %s milestone', (status) => {
    const m = milestone({ status, evidenceHash: 'b'.repeat(64) });
    expect(
      milestoneActions(WALLETS.outsider, order(), m, finance({ positions: [position()] })),
    ).toEqual([]);
  });

  it('a disconnected visitor is offered nothing at all', () => {
    expect(milestoneActions(undefined, order(), milestone(), finance())).toEqual([]);
    expect(orderActions(undefined, order({ status: 'CREATED' }))).toEqual([]);
  });

  it('nothing is offered on a completed or cancelled order', () => {
    for (const status of ['COMPLETED', 'CANCELLED'] as const) {
      expect(milestoneActions(WALLETS.supplier, order({ status }), milestone(), finance())).toEqual(
        [],
      );
    }
  });
});

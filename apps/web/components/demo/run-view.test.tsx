// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WalletState } from '@/lib/wallet/controller';
import { finance, milestone, order, position, WALLETS } from '@/lib/test/fixtures';
import { renderWithData } from '@/test/render';

import { RunView } from './run-view';

const wallet = vi.hoisted(() => ({ state: { phase: 'disconnected' } as WalletState }));
vi.mock('@/lib/wallet/provider', () => ({
  useWallet: () => ({ controller: { signRaw: vi.fn(), connect: vi.fn() }, state: wallet.state }),
}));

function connect(address: string) {
  wallet.state = { phase: 'connected', address, trustline: 'present' };
}

const SETTLEMENT_TX = 'c'.repeat(64);

function show(
  m: ReturnType<typeof milestone>,
  f: ReturnType<typeof finance>,
  overrides: Parameters<typeof order>[0] = {},
) {
  const data = order({ orderId: '2', status: 'ACTIVE', milestones: [m], ...overrides });
  return renderWithData(<RunView orderId="2" />, {
    order: data,
    finance: { [m.milestoneId]: f },
    evidence: {
      [m.milestoneId]: {
        milestoneId: m.milestoneId,
        onChainEvidenceHash: m.evidenceHash,
        documents: [],
      },
    },
  });
}

beforeEach(() => {
  wallet.state = { phase: 'disconnected' };
  window.localStorage.clear();
});

describe('demo progress on a run', () => {
  it('derives every step from the read model', () => {
    connect(WALLETS.supplier);
    show(milestone({ status: 'FINANCED' }), finance({ positions: [position()] }));

    expect(screen.getByText(/Where this trade has got to/i)).toBeTruthy();
    expect(screen.getAllByText(/Advance received/).length).toBeGreaterThan(0);
    // created, accepted, protected, requested, offered, chosen, advanced.
    expect(screen.getByText((_text, node) => node?.textContent === '7 of 10 steps')).toBeTruthy();
    expect(screen.getByText(/Nothing here can be ticked by hand/i)).toBeTruthy();
  });

  it('offers no way to mark a financial step by hand', () => {
    connect(WALLETS.buyer);
    const { container } = show(milestone({ status: 'FUNDED' }), finance());
    const progress = container.querySelector('ol');
    expect(progress).not.toBeNull();
    // A checklist a person can click would make the demo a claim, not a record.
    expect(progress?.querySelectorAll('input[type="checkbox"]').length).toBe(0);
    expect(progress?.querySelectorAll('button').length).toBe(0);
  });

  it('tells the connected wallet what it can do next', () => {
    connect(WALLETS.buyer);
    show(milestone({ status: 'UNFUNDED', fundedAmount: '0', fullyFunded: false }), finance());
    expect(screen.getByText(/Your next action as Buyer/i)).toBeTruthy();
    expect(screen.getAllByText(/Protect this milestone payment/i).length).toBeGreaterThan(0);
  });

  it('says plainly when the next move belongs to someone else', () => {
    connect(WALLETS.attestor);
    show(milestone({ status: 'FUNDED' }), finance());
    expect(screen.getByText(/Nothing for this wallet to do right now/i)).toBeTruthy();
    expect(screen.getByText(/Switch Freighter to their account/i)).toBeTruthy();
  });
});

describe('the run is the real product', () => {
  it('embeds the ordinary milestone card, with the two money pools', () => {
    connect(WALLETS.supplier);
    show(milestone({ status: 'FINANCED' }), finance({ positions: [position()] }));

    const pools = screen.getByTestId('money-pools');
    expect(within(pools).getByText('2,000.00 USDC')).toBeTruthy();
    expect(within(pools).getByText('1,400.00 USDC')).toBeTruthy();
    // Never a combined figure: buyer escrow and funder advance stay separate.
    expect(screen.queryByText(/3,400/)).toBeNull();
  });

  it('keeps the Anchor route to local money on the supplier’s advance', () => {
    connect(WALLETS.supplier);
    show(milestone({ status: 'FINANCED' }), finance({ positions: [position()] }));

    const convert = screen.getByRole('link', { name: 'Convert to TRY' });
    // The PKG-07 flow, prefilled — not a second Anchor implementation.
    expect(convert.getAttribute('href')).toBe(
      '/app/anchor?direction=withdraw&amount=1400.00&milestone=1',
    );
  });

  it('links only to transactions the indexer actually recorded', () => {
    connect(WALLETS.buyer);
    const { container } = show(
      milestone({ status: 'SETTLED', fundedAmount: '0', fullyFunded: false }),
      finance({
        positions: [position({ status: 'REPAID' })],
        settlement: {
          protectedAmount: '20000000000',
          funderRepayment: '14450000000',
          supplierPayout: '5550000000',
          settledAt: '2026-09-20T00:00:00.000Z',
          settledTxHash: SETTLEMENT_TX,
        },
      }),
      { status: 'COMPLETED' },
    );

    const links = [...container.querySelectorAll('a[href*="stellar.expert"]')].map((link) =>
      link.getAttribute('href'),
    );
    expect(links.length).toBeGreaterThan(0);
    // Every hash on the page came from the read model's own fields.
    const allowed = ['a'.repeat(64), SETTLEMENT_TX];
    for (const href of links) {
      const hash = href?.split('/').at(-1) ?? '';
      expect(allowed).toContain(hash);
    }
    expect(container.textContent).not.toMatch(/0x[0-9a-f]{6}/i);
  });
});

describe('evidence in a demo', () => {
  it('offers a harmless sample and is honest about what reaches Stellar', () => {
    connect(WALLETS.supplier);
    show(milestone({ status: 'FINANCED' }), finance({ positions: [position()] }));

    const sample = screen.getByRole('link', { name: /sample QC report/i });
    expect(sample.getAttribute('href')).toBe('/demo/sample-qc-report.txt');
    expect(screen.getByText(/bytes stay off-chain/i)).toBeTruthy();
    expect(screen.getByText(/Stellar cannot inspect goods/i)).toBeTruthy();
  });

  it('stops offering it once the milestone is settled', () => {
    connect(WALLETS.supplier);
    show(milestone({ status: 'SETTLED', fundedAmount: '0', fullyFunded: false }), finance(), {
      status: 'COMPLETED',
    });
    expect(screen.queryByRole('link', { name: /sample QC report/i })).toBeNull();
  });
});

describe('running the demo again', () => {
  it('never offers to rewind a finished trade', () => {
    connect(WALLETS.buyer);
    show(milestone({ status: 'SETTLED', fundedAmount: '0', fullyFunded: false }), finance(), {
      status: 'COMPLETED',
    });

    expect(screen.getByText(/Settled and refunded milestones are permanent/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Start a new trade/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /reset/i })).toBeNull();
  });

  it('is clear that removing a run only clears this browser', () => {
    connect(WALLETS.buyer);
    show(milestone({ status: 'FUNDED' }), finance());
    expect(screen.getByRole('button', { name: /Remove from this browser/i })).toBeTruthy();
    expect(screen.getByText(/stays on Stellar exactly as it is/i)).toBeTruthy();
  });
});

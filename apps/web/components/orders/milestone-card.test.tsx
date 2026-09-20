// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WalletState } from '@/lib/wallet/controller';
import {
  finance,
  milestone,
  offer,
  openRequest,
  order,
  position,
  WALLETS,
} from '@/lib/test/fixtures';
import { renderWithData } from '@/test/render';

import { MilestoneCard } from './milestone-card';

const wallet = vi.hoisted(() => ({ state: { phase: 'disconnected' } as WalletState }));
vi.mock('@/lib/wallet/provider', () => ({
  useWallet: () => ({ controller: { signRaw: vi.fn() }, state: wallet.state }),
}));

function connect(address: string) {
  wallet.state = { phase: 'connected', address, trustline: 'present' };
}

function show(
  m: ReturnType<typeof milestone>,
  f: ReturnType<typeof finance>,
  viewer: string | undefined,
) {
  const o = order({ milestones: [m] });
  return renderWithData(<MilestoneCard order={o} milestone={m} wallet={viewer} />, {
    finance: { [m.milestoneId]: f },
    evidence: {
      [m.milestoneId]: {
        milestoneId: m.milestoneId,
        onChainEvidenceHash: m.evidenceHash,
        documents: m.evidenceHash
          ? [
              {
                contentHash: m.evidenceHash,
                filename: '<script>alert(1)</script>.pdf',
                mimeType: 'application/pdf',
                byteSize: '1024',
                documentLabel: 'QC report',
                uploadedBy: WALLETS.supplier,
                anchoredOnChain: true,
                anchoredTxHash: 'e'.repeat(64),
                createdAt: '2026-09-19T18:00:00.000Z',
              },
            ]
          : [],
      },
    },
  });
}

beforeEach(() => {
  wallet.state = { phase: 'disconnected' };
  // No test should reach the network; anything unseeded stays pending.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => undefined)),
  );
});

describe('protected milestone vs funder advance', () => {
  it('shows the two pools separately, with supplier-facing honesty', () => {
    connect(WALLETS.supplier);
    show(milestone({ status: 'FINANCED' }), finance({ positions: [position()] }), WALLETS.supplier);

    const protectedPool = screen.getByTestId('pool-protected');
    const capitalPool = screen.getByTestId('pool-capital');
    expect(within(protectedPool).getByText('2,000.00 USDC')).toBeTruthy();
    expect(within(protectedPool).getByText(/not money you have received/)).toBeTruthy();
    expect(within(capitalPool).getByText('1,400.00 USDC')).toBeTruthy();
    expect(within(capitalPool).getByText(/yours to use now/)).toBeTruthy();
    // Never a combined figure.
    expect(screen.queryByText(/3,400/)).toBeNull();
    // AGENTS.md: funder repayment 1,445 first, supplier remainder 555.
    expect(screen.getByTestId('pool-expected').textContent).toMatch(
      /1,445\.00 USDC first.*555\.00 USDC/,
    );
  });

  it('stops calling the split conditional once the attestor has verified it', () => {
    connect(WALLETS.supplier);
    const financed = show(
      milestone({ status: 'FINANCED' }),
      finance({ positions: [position()] }),
      WALLETS.supplier,
    );
    expect(screen.getByTestId('pool-expected').textContent).toMatch(
      /When this milestone is verified/,
    );
    financed.unmount();

    show(milestone({ status: 'VERIFIED' }), finance({ positions: [position()] }), WALLETS.supplier);
    const expected = screen.getByTestId('pool-expected');
    expect(expected.textContent).toMatch(/Ready to settle/);
    expect(expected.textContent).not.toMatch(/When this milestone is verified/);
    // The money has not moved: still a preview of what settlement will do.
    expect(expected.textContent).toMatch(/1,445\.00 USDC first.*555\.00 USDC/);
    expect(expected.textContent).toMatch(/preview/);
  });

  /**
   * After release the contract holds nothing. A card that still reads
   * "Protected by buyer 2,000.00 USDC — held on Stellar" tells the buyer their
   * money is in escrow when it has already been paid out or returned.
   */
  it('stops claiming escrow is held once the milestone is settled', () => {
    connect(WALLETS.buyer);
    const settlement = {
      protectedAmount: '20000000000',
      funderRepayment: '14450000000',
      supplierPayout: '5550000000',
      settledAt: '2026-09-20T00:00:00.000Z',
      settledTxHash: 'c'.repeat(64),
    };
    show(
      // The chain zeroes the escrow at settlement; so does the read model.
      milestone({ status: 'SETTLED', fundedAmount: '0', fullyFunded: false }),
      finance({ positions: [position({ status: 'REPAID' })], settlement }),
      WALLETS.buyer,
    );

    const pool = screen.getByTestId('pool-protected');
    expect(within(pool).getByText('Currently protected')).toBeTruthy();
    expect(within(pool).getByText('0.00 USDC')).toBeTruthy();
    expect(pool.textContent).toMatch(/Originally protected: 2,000\.00 USDC/);
    expect(pool.textContent).toMatch(/released at settlement\. The contract no longer holds it/);
    // The live-escrow copy must be gone: this money has already been paid out.
    expect(pool.textContent).not.toMatch(/Held on Stellar/);
    expect(pool.textContent).not.toMatch(/Released only after verification/);
    expect(pool.textContent).not.toMatch(/fully protected/);
    // The chain's own figures stay on the settlement panel.
    expect(screen.getByTestId('pool-settled').textContent).toMatch(
      /1,445\.00 USDC repaid to the funder first, then 555\.00 USDC/,
    );
  });

  it('stops claiming escrow is held once the milestone is refunded', () => {
    connect(WALLETS.buyer);
    const refund = {
      refundedAmount: '20000000000',
      funderAdvanceOutstanding: '14000000000',
      refundedAt: '2026-09-20T00:00:00.000Z',
      refundedTxHash: 'd'.repeat(64),
    };
    show(
      milestone({ status: 'REFUNDED', fundedAmount: '0', fullyFunded: false }),
      finance({ positions: [position({ status: 'CLOSED' })], refund }),
      WALLETS.buyer,
    );

    const pool = screen.getByTestId('pool-protected');
    expect(within(pool).getByText('Currently protected')).toBeTruthy();
    expect(within(pool).getByText('0.00 USDC')).toBeTruthy();
    expect(pool.textContent).toMatch(/Originally protected: 2,000\.00 USDC/);
    expect(pool.textContent).toMatch(
      /returned to the buyer after the dispute was resolved as a refund/,
    );
    // Neither half of the live-escrow sentence may survive into a refund.
    expect(pool.textContent).not.toMatch(/Held on Stellar/);
    expect(pool.textContent).not.toMatch(/Released only after verification/);
    expect(pool.textContent).not.toMatch(/never paid early/);
    // The advance was not clawed back, and the card still says so.
    expect(screen.getByTestId('pool-refunded').textContent).toMatch(/was not reversed/);
  });

  it('still says protected money is held while the milestone is live', () => {
    connect(WALLETS.buyer);
    for (const status of ['FUNDED', 'FINANCE_REQUESTED', 'FINANCED', 'SUBMITTED', 'VERIFIED']) {
      const rendered = show(
        milestone({ status: status as ReturnType<typeof milestone>['status'] }),
        finance({ positions: status === 'FUNDED' ? [] : [position()] }),
        WALLETS.buyer,
      );
      const pool = screen.getByTestId('pool-protected');
      expect(within(pool).getByText('Protected by buyer')).toBeTruthy();
      expect(pool.textContent).toMatch(/Held on Stellar/);
      expect(pool.textContent).toMatch(/2,000\.00 USDC/);
      rendered.unmount();
    }
  });

  /**
   * A disputed milestone has two possible endings and the resolver picks one.
   * Showing only the settle split reads like a promise the contract has not
   * made to anyone.
   */
  it('presents both dispute outcomes instead of promising verification', () => {
    connect(WALLETS.supplier);
    show(milestone({ status: 'DISPUTED' }), finance({ positions: [position()] }), WALLETS.supplier);

    const panel = screen.getByTestId('pool-dispute');
    expect(within(panel).getByText('Awaiting resolver decision')).toBeTruthy();
    expect(panel.textContent).toMatch(/If they settle:.*1,445\.00 USDC first.*555\.00 USDC/);
    expect(panel.textContent).toMatch(/If they refund: the protected 2,000\.00 USDC returns/);
    // The funder's exposure is stated, not glossed over.
    expect(panel.textContent).toMatch(/1,400\.00 USDC advance is not clawed back/);
    expect(screen.queryByTestId('pool-expected')).toBeNull();
    expect(screen.queryByText(/When this milestone is verified/)).toBeNull();
    // The money is still locked while the resolver decides.
    expect(screen.getByTestId('pool-protected').textContent).toMatch(/Held on Stellar/);
  });

  it('states the unfinanced dispute outcome without inventing a funder', () => {
    connect(WALLETS.buyer);
    show(milestone({ status: 'DISPUTED' }), finance(), WALLETS.buyer);

    const panel = screen.getByTestId('pool-dispute');
    expect(panel.textContent).toMatch(
      /If they settle: the supplier receives the protected 2,000\.00 USDC/,
    );
    expect(panel.textContent).toMatch(
      /If they refund: the protected 2,000\.00 USDC returns to the buyer/,
    );
    expect(panel.textContent).not.toMatch(/advance/);
  });

  it('never labels buyer escrow as supplier balance or available cash', () => {
    connect(WALLETS.supplier);
    const { container } = show(milestone(), finance(), WALLETS.supplier);
    expect(container.textContent).not.toMatch(/supplier balance|available cash/i);
  });
});

describe('the supplier workflow', () => {
  it('offers Convert to TRY with the advance amount once working capital arrives', () => {
    connect(WALLETS.supplier);
    show(milestone({ status: 'FINANCED' }), finance({ positions: [position()] }), WALLETS.supplier);
    const link = screen.getByRole('link', { name: 'Convert to TRY' });
    expect(link.getAttribute('href')).toBe(
      '/app/anchor?direction=withdraw&amount=1400.00&milestone=1',
    );
  });

  it('does not offer the buyer a conversion of the supplier’s advance', () => {
    connect(WALLETS.buyer);
    show(milestone({ status: 'FINANCED' }), finance({ positions: [position()] }), WALLETS.buyer);
    expect(screen.queryByRole('link', { name: 'Convert to TRY' })).toBeNull();
  });

  it('lets the supplier compare offers and choose a live one', () => {
    connect(WALLETS.supplier);
    show(
      milestone({ status: 'FINANCE_REQUESTED' }),
      finance({
        request: openRequest(),
        offers: [offer({ offerId: '1' }), offer({ offerId: '2', repayment: '14700000000' })],
      }),
      WALLETS.supplier,
    );
    expect(screen.getAllByRole('button', { name: 'Choose' })).toHaveLength(2);
    // Cheapest offer first.
    const rows = screen.getAllByRole('row');
    expect(rows[1]?.textContent).toMatch(/1,445\.00/);
  });
});

describe('role-scoped actions', () => {
  const submitted = milestone({ status: 'SUBMITTED', evidenceHash: 'b'.repeat(64) });

  it('shows Verify only to the assigned attestor', () => {
    connect(WALLETS.attestor);
    show(submitted, finance(), WALLETS.attestor);
    expect(screen.getByRole('heading', { name: 'Your next step' })).toBeTruthy();
    expect(screen.getByText('Verify this milestone')).toBeTruthy();
    expect(screen.getByText(/cannot inspect goods or documents itself/)).toBeTruthy();
  });

  it('shows the SETTLE / REFUND decision only to the resolver', () => {
    connect(WALLETS.resolver);
    show(milestone({ status: 'DISPUTED' }), finance({ positions: [position()] }), WALLETS.resolver);
    expect(screen.getByText('Resolve this dispute')).toBeTruthy();
    expect(screen.getByLabelText(/Settle — the work stands/)).toBeTruthy();
    expect(screen.getByLabelText(/Refund — return the protected payment/)).toBeTruthy();
  });

  it('shows an unrelated wallet no actions at all', () => {
    connect(WALLETS.outsider);
    show(submitted, finance(), WALLETS.outsider);
    expect(screen.queryByRole('heading', { name: 'Your next step' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Review in wallet/ })).toBeNull();
  });

  it('shows a disconnected visitor no actions', () => {
    show(submitted, finance(), undefined);
    expect(screen.queryByRole('heading', { name: 'Your next step' })).toBeNull();
  });

  it('shows the chosen funder how the advance moves: from their wallet, not escrow', () => {
    connect(WALLETS.funder);
    show(
      milestone({ status: 'FINANCE_REQUESTED' }),
      finance({
        request: { ...openRequest(), status: 'ACCEPTED' },
        offers: [offer({ status: 'ACCEPTED' })],
      }),
      WALLETS.funder,
    );
    expect(screen.getByText('Send the working capital')).toBeTruthy();
    expect(screen.getByText(/stays locked and is not touched/)).toBeTruthy();
    expect(screen.getByText('This is not a guaranteed return')).toBeTruthy();
  });
});

describe('derived states and evidence', () => {
  it('marks a missed target date as derived, and says it moves no money', () => {
    connect(WALLETS.buyer);
    show(milestone({ derivedStatus: 'DELAYED' }), finance(), WALLETS.buyer);
    const badge = screen.getByText('Past target date');
    expect(badge.getAttribute('title')).toMatch(/Not a Stellar contract status/);
    expect(screen.getByText(/never releases, refunds or moves money/)).toBeTruthy();
  });

  it('shows the document that matches the on-chain commitment, rendering names as text', () => {
    connect(WALLETS.buyer);
    const { container } = show(
      milestone({ status: 'SUBMITTED', evidenceHash: 'b'.repeat(64) }),
      finance(),
      WALLETS.buyer,
    );
    expect(screen.getByText('Matches commitment')).toBeTruthy();
    // A hostile filename is displayed, never executed.
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText(/<script>alert\(1\)<\/script>\.pdf/)).toBeTruthy();
  });
});

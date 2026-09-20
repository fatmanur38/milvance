// @vitest-environment jsdom
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { metricsFixture } from '@/lib/test/metrics-fixture';
import { renderWithData } from '@/test/render';

import { TractionView } from './traction-view';

/**
 * The traction page must be impossible to misread in our favour: a zero stays a
 * zero, our own wallets are never presented as adoption, and Anchor reports are
 * never dressed up as chain proof.
 */
function show(overrides: Parameters<typeof metricsFixture>[0] = {}) {
  return renderWithData(<TractionView />, { metrics: metricsFixture(overrides) });
}

describe('traction is labelled as testnet activity', () => {
  it('says so before showing a single number', () => {
    show();
    expect(screen.getByText(/Stellar Testnet activity/i)).toBeTruthy();
    expect(screen.getByText(/Indexed through ledger 4769467/)).toBeTruthy();
  });
});

describe('external adoption', () => {
  it('shows a plain zero, and says why, rather than borrowing protocol numbers', () => {
    show();
    const external = screen.getByText('External wallets').parentElement;
    expect(external?.textContent).toContain('0');
    expect(screen.getByText(/No external participants yet/i)).toBeTruthy();
    expect(screen.getByText(/rather show a zero than label our own demo wallets/i)).toBeTruthy();
  });

  it('never presents team wallets as adoption', () => {
    show({
      adoption: { externalWallets: 0, teamWallets: 5, unclassifiedWallets: 0, distinctWallets: 5 },
    });
    expect(screen.getByText('Team wallets').parentElement?.textContent).toContain('5');
    expect(screen.getByText('External wallets').parentElement?.textContent).toContain('0');
  });

  it('reports a real external participant once one exists', () => {
    show({
      adoption: { externalWallets: 1, teamWallets: 5, unclassifiedWallets: 0, distinctWallets: 6 },
    });
    expect(screen.getByText('External wallets').parentElement?.textContent).toContain('1');
    expect(screen.queryByText(/No external participants yet/i)).toBeNull();
  });
});

describe('protocol activity', () => {
  it('formats exact base units into USDC without inventing precision', () => {
    show();
    expect(screen.getByText('20.00 USDC')).toBeTruthy(); // protected
    expect(screen.getByText('8.00 USDC')).toBeTruthy(); // advanced
    expect(screen.getByText('9.00 USDC')).toBeTruthy(); // repaid to funder
  });

  it('keeps escrow and advances apart, never showing a combined figure', () => {
    const { container } = show();
    // 20 protected + 8 advanced must never appear as 28.
    expect(container.textContent).not.toMatch(/28\.00 USDC/);
  });

  it('marks the section as including our own wallets', () => {
    show();
    expect(screen.getByText(/includes our own demo wallets/i)).toBeTruthy();
  });
});

describe('local payments', () => {
  it('says the fiat figures are the Anchor’s word', () => {
    show();
    expect(screen.getByText(/A bank transfer leaves no trace on any blockchain/i)).toBeTruthy();
    expect(screen.getByText('1000.0000000 TRY')).toBeTruthy();
  });

  it('surfaces reports that Stellar contradicts instead of hiding them', () => {
    show();
    expect(screen.getByText(/Some reports do not match Stellar/i)).toBeTruthy();
  });

  it('says nothing about mismatches when there are none', () => {
    show({
      localPayments: {
        onRampsReported: 1,
        offRampsReported: 0,
        legsChainConfirmed: 1,
        legsMismatched: 0,
        legsUnchecked: 0,
        tryOnboarded: '1000.0000000',
        tryPaidToSuppliers: '0.0000000',
      },
    });
    expect(screen.queryByText(/Some reports do not match Stellar/i)).toBeNull();
  });
});

describe('the north-star metric', () => {
  it('shows zero and names exactly what is missing', () => {
    show();
    const cycles = screen.getAllByTestId('cycle-row');
    expect(cycles).toHaveLength(1);
    expect(within(cycles[0]!).getByText('Not counted')).toBeTruthy();
    expect(cycles[0]!.textContent).toMatch(/no local-money conversion is confirmed on Stellar/i);
  });

  it('links a counted cycle to the transaction that proves its local-payment leg', () => {
    show({
      northStar: {
        completedLocalPaymentFinanceCycles: 1,
        candidateCycles: 1,
        supplierOffRampCycles: 1,
        buyerOnRampCycles: 0,
        cycles: [
          {
            milestoneId: '2',
            orderId: '2',
            counted: true,
            link: 'supplier-offramp',
            localPaymentTxHash: 'c'.repeat(64),
            missing: [],
          },
        ],
      },
    });
    const cycle = screen.getByTestId('cycle-row');
    expect(within(cycle).getByText('Counted')).toBeTruthy();
    const link = within(cycle).getByRole('link');
    expect(link.getAttribute('href')).toContain('c'.repeat(64));
  });

  it('refuses to claim the same USDC units flowed through', () => {
    show();
    expect(screen.getByText(/USDC is fungible/i)).toBeTruthy();
  });
});

describe('every number is explainable', () => {
  it('shows each definition with its source and exclusions on request', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: /Show all 5 definitions/i }));
    expect(screen.getAllByText(/Completed local-payment finance cycles/).length).toBeGreaterThan(1);
    expect(screen.getAllByText(/Source:/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Excludes:/).length).toBeGreaterThan(0);
    expect(screen.getByText(/A wallet connection is a browser event/i)).toBeTruthy();
  });

  it('marks which numbers are on chain and which are only reported', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: /Show all 5 definitions/i }));
    expect(screen.getAllByText('On chain').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Anchor-reported').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Excludes team').length).toBeGreaterThan(0);
  });
});

describe('timings', () => {
  it('prints a dash rather than a zero for something that has not happened', () => {
    show();
    const cell = screen.getByText('Median time from advance to local cash').parentElement;
    expect(cell?.textContent).toContain('—');
  });
});

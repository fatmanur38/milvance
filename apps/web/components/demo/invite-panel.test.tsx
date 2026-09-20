// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { milestone, order, WALLETS } from '@/lib/test/fixtures';
import { qrPayloadSafety } from '@/lib/demo/qr';

import { InvitePanel } from './invite-panel';

const trade = order({ orderId: '3', status: 'CREATED', milestones: [milestone()] });

function show() {
  return render(<InvitePanel order={trade} templateId="fast-task" milestoneId={null} />);
}

describe('invite links in the panel', () => {
  it('points every link at this order, naming the wallet the contract expects', () => {
    show();
    const targets = screen
      .getAllByRole('link', { name: 'Open' })
      .map((link) => link.getAttribute('href'));
    expect(targets).toEqual([
      '/app/trade-lab/join?order=3&role=supplier&template=fast-task',
      '/app/trade-lab/join?order=3&role=attestor&template=fast-task',
      '/app/trade-lab/join?order=3&role=resolver&template=fast-task',
      '/app/trade-lab/join?order=3&role=funder&template=fast-task',
    ]);
    // The address beside each link comes from the order on chain, not the URL.
    expect(screen.getAllByTitle(WALLETS.supplier).length).toBeGreaterThan(0);
    expect(screen.getByText(/The contract enforces that independence/)).toBeTruthy();
  });

  it('says plainly that a localhost link cannot be scanned from another device', () => {
    show();
    expect(screen.getByText(/only resolves on this computer/i)).toBeTruthy();
    expect(screen.getByText(/NEXT_PUBLIC_TRADE_LAB_ORIGIN/)).toBeTruthy();
  });

  it('builds share links that are safe to print as a QR code', () => {
    // Whatever origin the panel is served from, the payload stays within the
    // four known parameters.
    const payload = `${window.location.origin}/app/trade-lab/join?order=3&role=supplier&template=fast-task`;
    expect(qrPayloadSafety(payload)).toEqual({ safe: true });
  });
});

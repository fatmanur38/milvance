// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TransactionStatus } from './transaction-status';

const HASH = 'f'.repeat(64);

describe('transaction feedback', () => {
  it('asks for wallet approval, explicitly', () => {
    render(
      <TransactionStatus state={{ stage: 'awaiting-signature', label: 'Verify milestone' }} />,
    );
    expect(screen.getByText('Approve the request in your wallet.')).toBeTruthy();
  });

  it('says a declined signature submitted nothing', () => {
    render(
      <TransactionStatus
        state={{
          stage: 'failed',
          label: 'Protect milestone payment',
          failure: {
            kind: 'rejected',
            message: 'You declined the request in your wallet. Nothing was submitted.',
          },
        }}
      />,
    );
    expect(screen.getByRole('alert').textContent).toMatch(/Nothing was submitted/);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('distinguishes "confirmed on Stellar" from "workspace updated"', () => {
    const { rerender } = render(
      <TransactionStatus state={{ stage: 'syncing', label: 'x', hash: HASH, ledger: 1 }} />,
    );
    expect(screen.getByText('Confirmed on Stellar. Updating workspace…')).toBeTruthy();
    expect(screen.getByRole('link').getAttribute('href')).toContain(HASH);

    rerender(<TransactionStatus state={{ stage: 'synced', label: 'x', hash: HASH, ledger: 1 }} />);
    expect(screen.getByText('Confirmed on Stellar. Workspace updated.')).toBeTruthy();
  });

  it('never calls a confirmed transaction a failure when the indexer lags', () => {
    render(
      <TransactionStatus state={{ stage: 'sync-delayed', label: 'x', hash: HASH, ledger: 1 }} />,
    );
    expect(
      screen.getByText(/Confirmed on Stellar\. The workspace has not caught up yet/),
    ).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps raw detail folded away', () => {
    render(
      <TransactionStatus
        state={{
          stage: 'failed',
          label: 'x',
          failure: { kind: 'contract', message: 'Readable reason.', detail: 'AlreadyFinanced' },
        }}
      />,
    );
    expect(screen.getByText('Readable reason.')).toBeTruthy();
    expect(screen.getByText('Details').closest('details')?.open).toBe(false);
  });
});

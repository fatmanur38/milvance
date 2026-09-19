import { describe, expect, it } from 'vitest';

import { derivedOperationalStatus } from './serialise';

describe('derived logistics status', () => {
  const now = new Date('2026-09-19T12:00:00.000Z');
  const yesterday = new Date('2026-09-18T12:00:00.000Z');

  it('shows delay without changing the financial status', () => {
    expect(derivedOperationalStatus('FINANCED', yesterday, now)).toBe('DELAYED');
    expect(derivedOperationalStatus('FUNDED', yesterday, now)).toBe('DELAYED');
  });

  it('requires human review for submitted or disputed work', () => {
    expect(derivedOperationalStatus('SUBMITTED', yesterday, now)).toBe('NEEDS_REVIEW');
    expect(derivedOperationalStatus('DISPUTED', yesterday, now)).toBe('NEEDS_REVIEW');
  });

  it('does not mark terminal financial states as delayed', () => {
    expect(derivedOperationalStatus('SETTLED', yesterday, now)).toBe('CLOSED');
    expect(derivedOperationalStatus('REFUNDED', yesterday, now)).toBe('CLOSED');
  });
});

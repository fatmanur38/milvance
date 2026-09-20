import { afterEach } from 'vitest';

// Testing Library only auto-cleans when test globals exist; Vitest runs without them.
afterEach(async () => {
  if (typeof document !== 'undefined') {
    const { cleanup } = await import('@testing-library/react');
    cleanup();
  }
});

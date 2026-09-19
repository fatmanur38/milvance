import { describe, expect, it } from 'vitest';

import { Client, CONTRACT_BINDINGS_GENERATED } from './index.js';

describe('@milvance/contract-bindings', () => {
  it('exports the generated contract client', () => {
    expect(CONTRACT_BINDINGS_GENERATED).toBe(true);
    expect(Client).toBeTypeOf('function');
  });
});

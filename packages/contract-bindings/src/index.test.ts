import { describe, expect, it } from 'vitest';

import { CONTRACT_BINDINGS_GENERATED } from './index.js';

describe('@milvance/contract-bindings', () => {
  it('holds no generated bindings until PKG-05', () => {
    expect(CONTRACT_BINDINGS_GENERATED).toBe(false);
  });
});

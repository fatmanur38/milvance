import { describe, expect, it } from 'vitest';

import { ANCHOR_ADAPTER_IMPLEMENTED } from './index.js';

describe('@milvance/anchor', () => {
  it('is an unimplemented placeholder until PKG-07', () => {
    expect(ANCHOR_ADAPTER_IMPLEMENTED).toBe(false);
  });
});

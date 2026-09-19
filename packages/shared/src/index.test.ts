import { describe, expect, it } from 'vitest';

import { APP_ROLES, isAppRole, MILVANCE_PROTOCOL_VERSION } from './index.js';

describe('@milvance/shared', () => {
  it('exposes the pre-domain protocol version baseline', () => {
    expect(MILVANCE_PROTOCOL_VERSION).toBe(0);
  });

  it('recognises every declared application role', () => {
    for (const role of APP_ROLES) {
      expect(isAppRole(role)).toBe(true);
    }
  });

  it('rejects unknown roles', () => {
    expect(isAppRole('admin')).toBe(false);
    expect(isAppRole(undefined)).toBe(false);
  });
});

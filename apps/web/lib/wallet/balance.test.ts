import { describe, expect, it } from 'vitest';

import { testnetDeployment } from './config';
import { horizonBalanceToUnits, usdcHolding } from './balance';

describe('USDC balance pre-flight', () => {
  it('converts Horizon decimal balances exactly', () => {
    expect(horizonBalanceToUnits('20.3960908')).toBe(203_960_908n);
    expect(horizonBalanceToUnits('0.0000000')).toBe(0n);
    expect(horizonBalanceToUnits('60.3960908')).toBe(603_960_908n);
  });

  it('finds the approved USDC line only', () => {
    const balances = [
      { asset_type: 'native', balance: '9999.0000000' },
      {
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7',
        balance: '500.0000000',
      },
    ];
    // A look-alike USDC from another issuer is not the approved asset.
    expect(usdcHolding(balances)).toEqual({ status: 'no-trustline' });
    expect(
      usdcHolding([
        ...balances,
        {
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: testnetDeployment.usdcIssuer,
          balance: '12.5000000',
        },
      ]),
    ).toEqual({ status: 'ok', units: 125_000_000n });
  });
});

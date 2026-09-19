import { testnetDeployment } from './config';
import type { TrustlinePort, TrustlineStatus } from './ports';

interface HorizonBalance {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
}

export function usdcTrustlineStatus(balances: HorizonBalance[]): TrustlineStatus {
  return balances.some(
    (balance) =>
      balance.asset_type === 'credit_alphanum4' &&
      balance.asset_code === 'USDC' &&
      balance.asset_issuer === testnetDeployment.usdcIssuer,
  )
    ? 'present'
    : 'missing';
}

export class HorizonTrustline implements TrustlinePort {
  async check(address: string): Promise<TrustlineStatus> {
    const response = await fetch(
      `${testnetDeployment.horizonUrl}/accounts/${encodeURIComponent(address)}`,
      {
        cache: 'no-store',
      },
    );
    if (response.status === 404) return 'unfunded';
    if (!response.ok) throw new Error(`Could not check the Stellar account (${response.status}).`);
    const account = (await response.json()) as { balances?: HorizonBalance[] };
    if (!Array.isArray(account.balances)) throw new Error('Invalid account response from Horizon.');
    return usdcTrustlineStatus(account.balances);
  }
}

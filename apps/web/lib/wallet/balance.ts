import { parseUsdcInput } from '../domain/amounts';
import { testnetDeployment } from './config';

/**
 * Pre-flight USDC check for actions that move money.
 *
 * Asking someone to approve a wallet prompt that is certain to fail is poor
 * UX; telling them "you hold 3.00 USDC, this needs 2,000.00" before the prompt
 * is better. This is a courtesy only — the token contract enforces balances.
 */
export type UsdcHolding =
  { status: 'unfunded' } | { status: 'no-trustline' } | { status: 'ok'; units: bigint };

interface HorizonBalance {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance?: string;
}

/**
 * Horizon renders balances as decimal strings with 7 places ("20.3960908").
 * Convert exactly; a zero balance is valid here, unlike in user input.
 */
export function horizonBalanceToUnits(balance: string): bigint {
  if (/^0+(\.0+)?$/.test(balance)) return 0n;
  const parsed = parseUsdcInput(balance);
  if (!parsed.ok) throw new Error(`Unrecognised balance from Horizon: ${balance}`);
  return parsed.units;
}

export function usdcHolding(balances: HorizonBalance[]): UsdcHolding {
  const line = balances.find(
    (entry) =>
      entry.asset_type === 'credit_alphanum4' &&
      entry.asset_code === 'USDC' &&
      entry.asset_issuer === testnetDeployment.usdcIssuer,
  );
  if (line === undefined || line.balance === undefined) return { status: 'no-trustline' };
  return { status: 'ok', units: horizonBalanceToUnits(line.balance) };
}

export async function readUsdcHolding(address: string): Promise<UsdcHolding> {
  const response = await fetch(
    `${testnetDeployment.horizonUrl}/accounts/${encodeURIComponent(address)}`,
    { cache: 'no-store' },
  );
  if (response.status === 404) return { status: 'unfunded' };
  if (!response.ok) throw new Error(`Could not read the Stellar account (${response.status}).`);
  const account = (await response.json()) as { balances?: HorizonBalance[] };
  if (!Array.isArray(account.balances)) throw new Error('Invalid account response.');
  return usdcHolding(account.balances);
}

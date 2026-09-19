/**
 * SEP-1 discovery (PKG-07).
 *
 * Endpoints come from the Anchor's `stellar.toml`, never from constants, so
 * swapping the hackathon mock for a production Anchor is a home-domain change.
 * Anything Milvance depends on is validated here and fails loudly if absent,
 * rather than surfacing as a confusing 404 three steps later.
 */

import { AnchorError } from './errors.js';
import type { AnchorCapabilities, AnchorCurrency } from './types.js';

/** Minimal TOML reader for the flat keys and `[[CURRENCIES]]` blocks SEP-1 uses. */
function parseToml(text: string): {
  root: Record<string, string | string[]>;
  currencies: Record<string, string>[];
} {
  const root: Record<string, string | string[]> = {};
  const currencies: Record<string, string>[] = [];
  let current: Record<string, string> | null = null;
  let inRootTable = true;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    if (line === '[[CURRENCIES]]') {
      current = {};
      currencies.push(current);
      inRootTable = false;
      continue;
    }
    // Any other table ends both the root table and the current currency.
    if (line.startsWith('[')) {
      current = null;
      inRootTable = false;
      continue;
    }

    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const raw = line.slice(eq + 1).trim();

    if (current) {
      current[key] = unquote(raw);
    } else if (inRootTable) {
      root[key] = raw.startsWith('[') ? parseArray(raw) : unquote(raw);
    }
  }

  return { root, currencies };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseArray(value: string): string[] {
  const inner = value.replace(/^\[/, '').replace(/\]$/, '');
  return inner
    .split(',')
    .map((entry) => unquote(entry))
    .filter((entry) => entry !== '');
}

function requireString(
  root: Record<string, string | string[]>,
  key: string,
  homeDomain: string,
): string {
  const value = root[key];
  if (typeof value !== 'string' || value === '') {
    throw new AnchorError(
      'missing_capability',
      `${homeDomain} does not publish ${key}, which Milvance requires.`,
    );
  }
  return value;
}

/**
 * Parses and validates a SEP-1 document.
 *
 * `expectedNetworkPassphrase` guards against pointing a testnet build at a
 * mainnet Anchor, or the reverse — a mistake that would otherwise only show up
 * when a signature is rejected.
 */
export function parseStellarToml(
  text: string,
  homeDomain: string,
  expectedNetworkPassphrase?: string,
): AnchorCapabilities {
  const { root, currencies } = parseToml(text);

  const networkPassphrase = requireString(root, 'NETWORK_PASSPHRASE', homeDomain);
  if (expectedNetworkPassphrase !== undefined && networkPassphrase !== expectedNetworkPassphrase) {
    throw new AnchorError(
      'network_mismatch',
      `${homeDomain} serves a different Stellar network than this build targets.`,
    );
  }

  const parsedCurrencies: AnchorCurrency[] = currencies
    .filter((entry) => entry.code !== undefined && entry.issuer !== undefined)
    .map((entry) => {
      const currency: AnchorCurrency = {
        code: entry.code as string,
        issuer: entry.issuer as string,
      };
      return entry.anchor_asset === undefined
        ? currency
        : { ...currency, anchorAsset: entry.anchor_asset };
    });

  return {
    homeDomain,
    networkPassphrase,
    signingKey: requireString(root, 'SIGNING_KEY', homeDomain),
    webAuthEndpoint: requireString(root, 'WEB_AUTH_ENDPOINT', homeDomain),
    transferServer: requireString(root, 'TRANSFER_SERVER', homeDomain),
    kycServer: requireString(root, 'KYC_SERVER', homeDomain),
    quoteServer: requireString(root, 'ANCHOR_QUOTE_SERVER', homeDomain),
    currencies: parsedCurrencies,
  };
}

/** Confirms the Anchor actually ramps the asset Milvance settles in. */
export function requireCurrency(
  capabilities: AnchorCapabilities,
  code: string,
  issuer: string,
): AnchorCurrency {
  const match = capabilities.currencies.find(
    (currency) => currency.code === code && currency.issuer === issuer,
  );
  if (!match) {
    throw new AnchorError(
      'unsupported_asset',
      `${capabilities.homeDomain} does not ramp ${code} from the approved issuer.`,
    );
  }
  return match;
}

import { resolve } from 'node:path';

import { config as loadDotenv } from 'dotenv';

/**
 * Runtime configuration for the API and the indexer (AGENT.md §31).
 *
 * Validated eagerly at boot so a misconfigured deployment fails immediately
 * rather than half-working. Nothing here is ever logged: `DATABASE_URL` can
 * embed a password, so it is read once and passed straight to the driver.
 *
 * There is deliberately no signing key, no wallet seed and no Anchor token in
 * this contract. The backend has nothing to sign with, by construction.
 */
export interface StellarConfig {
  readonly network: string;
  readonly networkPassphrase: string;
  readonly rpcUrl: string;
  readonly horizonUrl: string;
  readonly contractId: string;
  readonly usdcIssuer: string;
  readonly usdcAssetContractId: string;
}

export interface IndexerConfig {
  /**
   * First ledger the indexer is responsible for.
   *
   * Defaults to the ledger the contract was deployed in, so a fresh database
   * backfills the entire history rather than starting at "now" and losing it.
   */
  readonly startLedger: bigint;
  /** Seconds between polls when running as a worker. */
  readonly pollIntervalSeconds: number;
  /**
   * Shared secret an external scheduler presents to run one indexer tick.
   *
   * Undefined disables the scheduled-tick endpoint entirely. That is the safe
   * default: an unauthenticated endpoint is never the fallback for a missing
   * secret. Server-side only — never a `NEXT_PUBLIC_*` value, never logged.
   */
  readonly cronSecret: string | undefined;
  /** Work limits for one bounded tick. See `IndexerService.tick`. */
  readonly tick: IndexerTickLimits;
}

/**
 * How much one tick may do before it stops and reports `caughtUp: false`.
 *
 * A tick runs inside an HTTP request, so it must end on its own terms rather
 * than when a proxy gives up. Stopping early is never data loss: the cursor
 * only ever advances over events that were stored, so the next tick resumes
 * exactly where this one stopped.
 */
export interface IndexerTickLimits {
  readonly maxPages: number;
  readonly maxEvents: number;
  readonly maxSeconds: number;
}

/**
 * Credentials for S3-compatible object storage.
 *
 * Server-side only. None of these may ever be exposed through a `NEXT_PUBLIC_*`
 * variable: the browser uploads evidence to the API, and the API is the only
 * thing that can reach the bucket.
 */
export interface S3Config {
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface EvidenceConfig {
  /** `local-dev` writes to a directory; `s3` talks to S3-compatible storage. */
  readonly driver: 'local-dev' | 's3';
  readonly localDirectory: string;
  readonly maxBytes: number;
  readonly endpoint: string | undefined;
  readonly bucket: string | undefined;
  /** Present only when the driver is `s3`. */
  readonly s3: S3Config | undefined;
}

export interface ApiConfig {
  readonly port: number;
  readonly nodeEnv: string;
  readonly databaseUrl: string;
  readonly stellar: StellarConfig;
  readonly indexer: IndexerConfig;
  readonly evidence: EvidenceConfig;
}

const DEFAULT_PORT = 3001;
/** Ledger in which MilvanceCore was deployed — see `deployments/testnet.json`. */
const DEFAULT_START_LEDGER = 4_760_607n;
const DEFAULT_MAX_EVIDENCE_BYTES = 25 * 1024 * 1024;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_PORT;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new ConfigError(`Invalid PORT: ${value}`);
  }
  return parsed;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim() === '') {
    // The value is never echoed — only the name of what is missing.
    throw new ConfigError(`Missing required environment variable: ${key}`);
  }
  return value.trim();
}

function optional(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

function parseBigInt(value: string | undefined, fallback: bigint, key: string): bigint {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  if (!/^\d+$/.test(value.trim())) {
    throw new ConfigError(`${key} must be a whole number of ledgers`);
  }
  return BigInt(value.trim());
}

function parseInteger(value: string | undefined, fallback: number, key: string): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`${key} must be a positive integer`);
  }
  return parsed;
}

/**
 * Refuse a scheduler secret that is too short to be worth having.
 *
 * A weak shared secret on an endpoint that writes to the read model is worse
 * than an obviously absent one, because it looks protected. The value itself is
 * never echoed, not even its length.
 */
const MIN_CRON_SECRET_LENGTH = 32;

function assertStrongSecret(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.length < MIN_CRON_SECRET_LENGTH) {
    throw new ConfigError(
      `INDEXER_CRON_SECRET must be at least ${MIN_CRON_SECRET_LENGTH} characters`,
    );
  }
  return value;
}

/** A Stellar contract id: 56 characters starting with `C`. */
function assertContractId(value: string, key: string): string {
  if (!/^C[A-Z2-7]{55}$/.test(value)) {
    throw new ConfigError(`${key} is not a Stellar contract id`);
  }
  return value;
}

/** A Stellar account public key: 56 characters starting with `G`. */
function assertPublicKey(value: string, key: string): string {
  if (!/^G[A-Z2-7]{55}$/.test(value)) {
    throw new ConfigError(`${key} is not a Stellar public key`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  if (env === process.env) {
    // `pnpm --filter @milvance/api` runs with apps/api as its cwd. Support both
    // a package-local .env and the repository-root .env documented in README.
    // Explicit process environment values win; neither file is ever logged.
    loadDotenv({
      path: [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')],
      quiet: true,
    });
  }
  const driver = optional(env, 'EVIDENCE_STORAGE_DRIVER') ?? 'local-dev';
  if (driver !== 'local-dev' && driver !== 's3') {
    throw new ConfigError(`EVIDENCE_STORAGE_DRIVER must be 'local-dev' or 's3'`);
  }

  return {
    port: parsePort(env.PORT),
    nodeEnv: env.NODE_ENV ?? 'development',
    databaseUrl: required(env, 'DATABASE_URL'),
    stellar: {
      network: optional(env, 'STELLAR_NETWORK') ?? 'testnet',
      networkPassphrase:
        optional(env, 'STELLAR_NETWORK_PASSPHRASE') ?? 'Test SDF Network ; September 2015',
      rpcUrl: optional(env, 'STELLAR_RPC_URL') ?? 'https://soroban-testnet.stellar.org',
      horizonUrl: optional(env, 'STELLAR_HORIZON_URL') ?? 'https://horizon-testnet.stellar.org',
      contractId: assertContractId(required(env, 'MILVANCE_CONTRACT_ID'), 'MILVANCE_CONTRACT_ID'),
      usdcIssuer: assertPublicKey(required(env, 'USDC_ISSUER'), 'USDC_ISSUER'),
      usdcAssetContractId: assertContractId(
        required(env, 'USDC_ASSET_CONTRACT_ID'),
        'USDC_ASSET_CONTRACT_ID',
      ),
    },
    indexer: {
      startLedger: parseBigInt(
        env.INDEXER_START_LEDGER,
        DEFAULT_START_LEDGER,
        'INDEXER_START_LEDGER',
      ),
      pollIntervalSeconds: parseInteger(env.INDEXER_POLL_SECONDS, 10, 'INDEXER_POLL_SECONDS'),
      cronSecret: assertStrongSecret(optional(env, 'INDEXER_CRON_SECRET')),
      tick: {
        maxPages: parseInteger(env.INDEXER_TICK_MAX_PAGES, 5, 'INDEXER_TICK_MAX_PAGES'),
        maxEvents: parseInteger(env.INDEXER_TICK_MAX_EVENTS, 500, 'INDEXER_TICK_MAX_EVENTS'),
        maxSeconds: parseInteger(env.INDEXER_TICK_MAX_SECONDS, 20, 'INDEXER_TICK_MAX_SECONDS'),
      },
    },
    evidence: {
      driver,
      localDirectory: optional(env, 'EVIDENCE_LOCAL_DIR') ?? '.evidence-store',
      maxBytes: parseInteger(
        env.EVIDENCE_MAX_BYTES,
        DEFAULT_MAX_EVIDENCE_BYTES,
        'EVIDENCE_MAX_BYTES',
      ),
      endpoint: optional(env, 'OBJECT_STORAGE_ENDPOINT'),
      bucket: optional(env, 'OBJECT_STORAGE_BUCKET'),
      s3:
        driver === 's3'
          ? {
              endpoint: required(env, 'OBJECT_STORAGE_ENDPOINT'),
              bucket: required(env, 'OBJECT_STORAGE_BUCKET'),
              // R2 ignores the region but still requires one in the signature.
              region: optional(env, 'OBJECT_STORAGE_REGION') ?? 'auto',
              accessKeyId: required(env, 'OBJECT_STORAGE_ACCESS_KEY'),
              secretAccessKey: required(env, 'OBJECT_STORAGE_SECRET_KEY'),
            }
          : undefined,
    },
  };
}

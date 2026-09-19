/**
 * Minimal runtime configuration for the API skeleton.
 *
 * Deliberately tiny: the full environment contract (AGENT.md §31) is validated in
 * PKG-08, once the endpoints that need those values exist.
 */
export interface ApiConfig {
  readonly port: number;
  readonly nodeEnv: string;
}

const DEFAULT_PORT = 3001;

export function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_PORT;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return {
    port: parsePort(env.PORT),
    nodeEnv: env.NODE_ENV ?? 'development',
  };
}
